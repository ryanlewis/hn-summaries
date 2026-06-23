// Orchestrates one refresh cycle: fetch the best list, summarize new stories
// with bounded concurrency, prune stale entries, and persist atomically.
import pLimit from "p-limit";
import {
  COMMENTS_TO_FETCH,
  COMMENT_MAX_CHARS,
  CONCURRENCY_LIMIT,
  FALLBACK_RETRY_ENABLED,
  MAX_CACHE_STORIES,
  MAX_FALLBACK_RETRIES,
  MAX_FALLBACK_RETRIES_PER_CYCLE,
  MAX_NEW_PER_REFRESH,
  SELFPOST_TEXT_MAX_CHARS,
} from "./config.js";
import {
  capCache,
  getStories,
  loadCache,
  pruneStale,
  saveCache,
  type CachedStory,
} from "./cache.js";
import { extractArticleTextTiered, htmlToText } from "./extract.js";
import { fetchBestIds, fetchComment, fetchStory } from "./hn.js";
import { summarize } from "./summarize.js";

export interface RefreshState {
  running: boolean;
  lastRefreshAt: number; // Date.now() of last successful completion
  lastDurationMs: number;
  lastNewCount: number;
  lastRecoveredCount: number; // fallbacks re-summarized successfully by the retry pass
  lastPruned: number; // off-list stories dropped past the retention window
  lastEvicted: number; // off-list stories dropped by the size cap
  lastError: string | null;
  totalRefreshes: number;
}

export const refreshState: RefreshState = {
  running: false,
  lastRefreshAt: 0,
  lastDurationMs: 0,
  lastNewCount: 0,
  lastRecoveredCount: 0,
  lastPruned: 0,
  lastEvicted: 0,
  lastError: null,
  totalRefreshes: 0,
};

async function gatherComments(kids: number[] | undefined): Promise<string> {
  const ids = (kids ?? []).slice(0, COMMENTS_TO_FETCH);
  if (ids.length === 0) return "";
  const comments = await Promise.all(ids.map(fetchComment));
  return comments
    .filter((c): c is NonNullable<typeof c> => c !== null && !!c.text)
    .map((c) => {
      const text = htmlToText(c.text!).slice(0, COMMENT_MAX_CHARS);
      return text ? `- ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function processStory(
  id: number,
  rank: number,
): Promise<CachedStory | null> {
  const story = await fetchStory(id);
  if (!story) return null;

  const commentsText = await gatherComments(story.kids);

  // Determine article text (or fallback reason).
  let articleText: string | undefined;
  let fallbackReason: string | undefined;

  if (!story.url) {
    if (story.text) {
      articleText = htmlToText(story.text).slice(0, SELFPOST_TEXT_MAX_CHARS);
    }
    if (!articleText) fallbackReason = "self-post without text";
  } else {
    const extracted = await extractArticleTextTiered(story.url);
    if (extracted.ok) articleText = extracted.text;
    else fallbackReason = extracted.reason;
  }

  const isFallback = !articleText;

  const summary = await summarize({
    title: story.title!,
    url: story.url,
    articleText,
    fallbackReason,
    commentsText,
  });

  return {
    id,
    title: story.title!,
    url: story.url,
    score: story.score ?? 0,
    by: story.by ?? "unknown",
    time: story.time ?? Math.floor(Date.now() / 1000),
    descendants: story.descendants ?? 0,
    summary,
    isFallback,
    fallbackReason: isFallback ? fallbackReason : undefined,
    generatedAt: Date.now(),
    rank,
    onList: true,
    lastSeenAt: Date.now(),
  };
}

/**
 * Re-extract an existing on-list fallback story in place. Always bumps the attempt
 * counter; only pays for a re-summarize when extraction now succeeds. Returns true if
 * the story was recovered (flipped out of fallback). Mutates `story` directly.
 */
async function retryFallback(story: CachedStory): Promise<boolean> {
  story.fallbackAttempts = (story.fallbackAttempts ?? 0) + 1;
  if (!story.url) return false; // self-post fallbacks aren't recoverable by extraction

  const extracted = await extractArticleTextTiered(story.url);
  if (!extracted.ok) {
    story.fallbackReason = extracted.reason; // record the latest reason
    return false;
  }

  // Extraction succeeded this time — re-summarize against the real article. Refresh the
  // item first to pick up current comments/score. If HN no longer serves it (deleted/dead
  // or a transient error), don't pay for a re-summarize or promote a stale entry out of
  // fallback — leave it as-is; a later cycle retries, or it ages off the list and is pruned.
  const fresh = await fetchStory(story.id);
  if (!fresh) return false;

  const commentsText = await gatherComments(fresh.kids);
  const summary = await summarize({
    title: story.title,
    url: story.url,
    articleText: extracted.text,
    commentsText,
  });
  story.summary = summary;
  story.isFallback = false;
  story.fallbackReason = undefined;
  story.generatedAt = Date.now();
  story.score = fresh.score ?? story.score;
  story.descendants = fresh.descendants ?? story.descendants;
  return true;
}

/** Run a single refresh cycle. Safe to call repeatedly; no-ops if already running. */
export async function runRefresh(): Promise<void> {
  if (refreshState.running) {
    console.log("[refresh] already running, skipping");
    return;
  }
  refreshState.running = true;
  const started = Date.now();
  try {
    // Work on a private clone of the in-memory cache. The HTTP server reads the live
    // singleton on every request, so mutating it in place would let /feed and / observe a
    // half-updated cycle (some ranks bumped, others not; prunes/new entries appearing one
    // at a time). saveCache() swaps this clone in as the new singleton atomically at the end.
    const cache = structuredClone(await loadCache());
    const bestIds = await fetchBestIds();
    if (bestIds.length === 0) {
      console.warn("[refresh] best list empty — leaving cache untouched");
      // Surface this in /status: lastRefreshAt stays at the last *successful* cycle, so
      // without this an operator can't tell "refreshing fine" from "repeatedly empty".
      refreshState.lastError = "best list empty — cycle skipped (transient)";
      return;
    }
    const now = Date.now();
    const currentIds = new Set(bestIds);
    const rankOf = new Map<number, number>();
    bestIds.forEach((id, i) => rankOf.set(id, i));

    // Mark every cached story on/off the current best list. On-list stories get a
    // fresh rank + lastSeenAt; off-list stories keep their summary (so a bounce-back
    // isn't re-summarized) and start/continue their retention clock.
    for (const story of Object.values(cache.stories)) {
      const on = currentIds.has(story.id);
      story.onList = on;
      if (on) {
        story.rank = rankOf.get(story.id)!;
        story.lastSeenAt = now;
      } else if (!story.lastSeenAt) {
        story.lastSeenAt = now;
      }
    }

    const allNew = bestIds.filter((id) => !cache.stories[String(id)]);
    const toProcess = allNew.slice(0, MAX_NEW_PER_REFRESH);
    const deferred = allNew.length - toProcess.length;
    const removed = pruneStale(cache, now); // only stories off-list past the retention window
    console.log(
      `[refresh] ${bestIds.length} best; ${toProcess.length} new to summarize${
        deferred > 0 ? ` (+${deferred} deferred to next cycle by cap)` : ""
      }; ${removed} pruned; cache ${Object.keys(cache.stories).length}`,
    );

    const limit = pLimit(CONCURRENCY_LIMIT);
    let done = 0;
    const results = await Promise.all(
      toProcess.map((id) =>
        limit(async () => {
          try {
            const entry = await processStory(id, rankOf.get(id)!);
            if (entry) {
              cache.stories[String(id)] = entry;
              done++;
              console.log(
                `[refresh] (${done}/${toProcess.length}) #${id} ${
                  entry.isFallback ? "[fallback] " : ""
                }${entry.title.slice(0, 70)}`,
              );
            }
            return entry;
          } catch (err) {
            console.error(
              `[refresh] story ${id} failed:`,
              err instanceof Error ? err.message : err,
            );
            return null; // leave uncached; retried next cycle
          }
        }),
      ),
    );

    // Retry pass: re-extract a bounded set of existing on-list fallbacks so the browser
    // tier (and recovered sites) can backfill stories already in the cache, which the
    // normal path never re-summarizes. Least-tried first so every fallback gets a fair
    // first attempt before any is retried again.
    let recoveredFallbacks = 0;
    if (FALLBACK_RETRY_ENABLED) {
      const retryable = Object.values(cache.stories)
        .filter(
          (s) =>
            s.onList !== false &&
            s.isFallback &&
            s.url &&
            (s.fallbackAttempts ?? 0) < MAX_FALLBACK_RETRIES,
        )
        // Least-tried first (fair first attempt for all), then by rank so the most
        // visible top-of-feed fallbacks are recovered soonest.
        .sort(
          (a, b) =>
            (a.fallbackAttempts ?? 0) - (b.fallbackAttempts ?? 0) ||
            a.rank - b.rank,
        )
        .slice(0, MAX_FALLBACK_RETRIES_PER_CYCLE);

      if (retryable.length > 0) {
        await Promise.all(
          retryable.map((story) =>
            limit(async () => {
              try {
                if (await retryFallback(story)) {
                  recoveredFallbacks++;
                  console.log(
                    `[refresh] recovered fallback #${story.id} ${story.title.slice(0, 70)}`,
                  );
                }
              } catch (err) {
                console.error(
                  `[refresh] fallback retry ${story.id} failed:`,
                  err instanceof Error ? err.message : err,
                );
              }
            }),
          ),
        );
        console.log(
          `[refresh] fallback retry: ${recoveredFallbacks}/${retryable.length} recovered`,
        );
      }
    }

    // Size backstop: enforce the hard ceiling after all additions, evicting the
    // oldest off-list summaries first (on-list stories are never evicted).
    const evicted = capCache(cache, MAX_CACHE_STORIES);
    if (evicted > 0) {
      console.log(
        `[refresh] size cap: evicted ${evicted}; cache ${Object.keys(cache.stories).length}/${MAX_CACHE_STORIES}`,
      );
    }

    cache.updatedAt = Date.now();
    await saveCache(cache);

    refreshState.lastNewCount = results.filter(Boolean).length;
    refreshState.lastRecoveredCount = recoveredFallbacks;
    refreshState.lastPruned = removed;
    refreshState.lastEvicted = evicted;
    refreshState.lastRefreshAt = Date.now();
    refreshState.lastError = null;
    refreshState.totalRefreshes++;
    console.log(
      `[refresh] done in ${((Date.now() - started) / 1000).toFixed(
        1,
      )}s; cache has ${getStories(cache).length} stories`,
    );
  } catch (err) {
    refreshState.lastError = err instanceof Error ? err.message : String(err);
    console.error("[refresh] cycle failed:", refreshState.lastError);
  } finally {
    refreshState.lastDurationMs = Date.now() - started;
    refreshState.running = false;
  }
}
