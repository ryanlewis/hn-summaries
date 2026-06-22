// Orchestrates one refresh cycle: fetch the best list, summarize new stories
// with bounded concurrency, prune stale entries, and persist atomically.
import pLimit from "p-limit";
import {
  COMMENTS_TO_FETCH,
  COMMENT_MAX_CHARS,
  CONCURRENCY_LIMIT,
  MAX_NEW_PER_REFRESH,
  SELFPOST_TEXT_MAX_CHARS,
} from "./config.js";
import {
  getStories,
  loadCache,
  pruneStale,
  saveCache,
  type CachedStory,
} from "./cache.js";
import { extractArticleText, htmlToText } from "./extract.js";
import { fetchBestIds, fetchComment, fetchStory } from "./hn.js";
import { summarize } from "./summarize.js";

export interface RefreshState {
  running: boolean;
  lastRefreshAt: number; // Date.now() of last successful completion
  lastDurationMs: number;
  lastNewCount: number;
  lastError: string | null;
  totalRefreshes: number;
}

export const refreshState: RefreshState = {
  running: false,
  lastRefreshAt: 0,
  lastDurationMs: 0,
  lastNewCount: 0,
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
    const extracted = await extractArticleText(story.url);
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
    generatedAt: Date.now(),
    rank,
    onList: true,
    lastSeenAt: Date.now(),
  };
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
    const cache = await loadCache();
    const bestIds = await fetchBestIds();
    if (bestIds.length === 0) {
      console.warn("[refresh] best list empty — leaving cache untouched");
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

    cache.updatedAt = Date.now();
    await saveCache(cache);

    refreshState.lastNewCount = results.filter(Boolean).length;
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
