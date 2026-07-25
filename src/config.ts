// Central configuration. Every tunable lives here.
import { fileURLToPath } from "node:url";

// --- Data sources ---
export const HN_BEST_URL = "https://hacker-news.firebaseio.com/v0/beststories.json";
export const HN_ITEM_URL = (id: number) =>
  `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
export const HN_COMMENTS_URL = (id: number) =>
  `https://news.ycombinator.com/item?id=${id}`;

// --- LLM gateway (exe.dev; auto-authenticates the VM, no API key needed) ---
// exe.dev LLM gateway. Anthropic Messages API at <base>/v1/messages; the VM is
// auto-authenticated (the equivalent of ANTHROPIC_BASE_URL=https://llm.int.exe.xyz
// with an implicit key), so no API key is sent.
export const LLM_ENDPOINT =
  process.env.LLM_ENDPOINT ?? "https://llm.int.exe.xyz/v1/messages";
export const LLM_MODEL = process.env.LLM_MODEL ?? "claude-sonnet-4-6";
export const ANTHROPIC_VERSION = "2023-06-01";
export const LLM_MAX_TOKENS = 400; // output cap (Anthropic path); the summary's length, not the reading budget
export const LLM_TIMEOUT_MS = 90_000; // reasoning models (gpt-5.5) can take longer

// Summarization backend.
//   "openai-responses" — exe.dev ChatGPT/Codex proxy (streaming Responses API).
//      Draws on the ChatGPT subscription instead of the metered LLM token allowance.
//   "anthropic" — the LLM gateway (claude-sonnet-4-6), metered against the allowance.
export const SUMMARY_PROVIDER = process.env.SUMMARY_PROVIDER ?? "openai-responses";
export const OPENAI_ENDPOINT =
  process.env.OPENAI_ENDPOINT ?? "https://chatgpt.int.exe.xyz/v1/responses";
export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.5";

/**
 * Parse an integer env var, falling back to `fallback` when unset or garbage.
 *
 * Most numeric config here is a plain `Number(process.env.X ?? default)`, which turns a
 * typo into NaN and lets it propagate. That's tolerable where NaN fails loudly, but the
 * two knobs below fail badly: a NaN concurrency makes pLimit() throw on every cycle, and
 * a NaN points threshold compares false against every score, silently summarizing nothing
 * and looking exactly like "HN was quiet today". Both are one typo away in a systemd unit.
 * Only the new knobs use this — retrofitting the rest is a separate change.
 */
function intEnv(raw: string | undefined, fallback: number, min: number): number {
  // Empty/whitespace-only counts as unset: `Number("")` is 0, so a bare
  // `Environment=MIN_POINTS_TO_SUMMARIZE=` in the unit would otherwise read as a
  // deliberate 0 and silently switch the gate off.
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

// --- Refresh / pipeline ---
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // hourly
// Local dev switch: when set, index.ts serves the existing cache and skips the boot +
// hourly refresh entirely — no HN fetch, no extraction, no summarization. Pair with a
// CACHE_PATH fixture to work on the render layer fully offline. See `bun run dev`.
export const REFRESH_DISABLED =
  (process.env.REFRESH_DISABLED ?? "false") !== "false";
export const CONCURRENCY_LIMIT = 5; // parallel fetch+summarize workers
// Hard cap on how many NEW stories are summarized per refresh cycle. Steady-state
// churn is well under this, so it never bites normally — it's a cost backstop so a
// wiped cache can't silently re-summarize the whole list in one hour. Excess
// stories are picked up on subsequent refreshes.
export const MAX_NEW_PER_REFRESH = 60;
// Concurrency for the per-cycle metadata sweep over the best list. These are cheap
// single-GET item reads (no extraction, no summarization), so they run wider than
// CONCURRENCY_LIMIT — the whole ~200-story sweep should finish in a few seconds.
export const METADATA_CONCURRENCY = intEnv(process.env.METADATA_CONCURRENCY, 12, 1);
// A story must reach this many points before it is summarized at all.
//
// Without a gate every story that so much as touches the best list gets summarized
// (~100/day), and each one is summarized at its *weakest* moment — on entry, when the
// discussion is a handful of comments. Waiting for a story to prove itself cuts both
// the feed volume and the LLM spend, and means the discussion summary is written
// against a mature thread.
//
// Measured against a live best list (~200 stories, median 59 points), roughly:
//   0   -> ~100/day (every story that touches the list)
//   100 -> ~30/day
//   300 -> ~13/day   <- default
//   500 -> ~6/day
// Set to 0 to restore the old summarize-everything behaviour.
export const MIN_POINTS_TO_SUMMARIZE = intEnv(
  process.env.MIN_POINTS_TO_SUMMARIZE,
  300,
  0,
);

// --- Article extraction ---
export const ARTICLE_FETCH_TIMEOUT_MS = 15_000;
export const ARTICLE_MAX_BYTES = 500_000; // cap body download before extraction
export const ARTICLE_TEXT_MAX_CHARS = 12_000; // ~3k tokens fed to the model
export const SELFPOST_TEXT_MAX_CHARS = 4_000;
export const USER_AGENT =
  "Mozilla/5.0 (compatible; HN-Summaries/1.0; +https://hn-summaries.exe.xyz)";

// --- Browser extraction (tiered fallback) ---
// When the plain fetch+Readability path fails with a *recoverable* reason, a real
// browser (Bun.WebView) renders the page and we re-run Readability over the rendered
// DOM. This is far heavier than fetch, so it's gated, throttled separately, and only
// invoked on the recoverable reasons below — never the default path.
//
// On Linux, Bun.WebView drives an installed Chrome/Chromium over the DevTools Protocol.
// It finds the binary via (in order): backend.path, $BUN_CHROME_PATH, $PATH, common
// system locations, then the Playwright cache. Install Chromium on the host or set
// BUN_CHROME_PATH for this tier to work.
export const BROWSER_FALLBACK_ENABLED =
  (process.env.BROWSER_FALLBACK_ENABLED ?? "true") !== "false";
export const BROWSER_CONCURRENCY = Number(process.env.BROWSER_CONCURRENCY ?? 2);
export const BROWSER_TIMEOUT_MS = Number(process.env.BROWSER_TIMEOUT_MS ?? 20_000);
// Short settle after the load event for late-rendering SPAs before grabbing the DOM.
export const BROWSER_SETTLE_MS = Number(process.env.BROWSER_SETTLE_MS ?? 1_200);
export const BROWSER_VIEWPORT_WIDTH = Number(process.env.BROWSER_VIEWPORT_WIDTH ?? 1280);
export const BROWSER_VIEWPORT_HEIGHT = Number(process.env.BROWSER_VIEWPORT_HEIGHT ?? 900);
// Fetch-path failures a browser render can plausibly recover. non-html / too-large are
// excluded — a renderer won't turn a PDF or an oversized file into an article.
export const BROWSER_RECOVERABLE_REASONS = ["error", "empty", "timeout"] as const;

// --- Fallback retry ---
// Already-cached fallbacks are never re-summarized by the normal path (ids in the cache
// are skipped). This pass re-runs extraction on existing on-list fallbacks each cycle and
// re-summarizes any that now succeed — recovering stories the browser tier can render or
// that were transiently down. Each story is retried at most MAX_FALLBACK_RETRIES times so
// hard paywalls/blocks aren't re-attempted forever; the per-cycle cap bounds the cost.
export const FALLBACK_RETRY_ENABLED =
  (process.env.FALLBACK_RETRY_ENABLED ?? "true") !== "false";
export const MAX_FALLBACK_RETRIES = Number(process.env.MAX_FALLBACK_RETRIES ?? 3);
export const MAX_FALLBACK_RETRIES_PER_CYCLE = Number(
  process.env.MAX_FALLBACK_RETRIES_PER_CYCLE ?? 10,
);

// --- Comments (for the "HN reaction" sentence) ---
export const COMMENTS_TO_FETCH = 10;
export const COMMENT_MAX_CHARS = 400;

// --- Retry/backoff for the gateway ---
export const RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 2_000; // 2s, 4s exponential

// --- Feed / server ---
export const DEFAULT_FEED_COUNT = 30;
export const MAX_FEED_COUNT = 200;
export const PORT = Number(process.env.PORT ?? 8000);
// Public origin (no trailing slash, no path). Feed lives at <origin>/feed.
export const PUBLIC_ORIGIN = (
  process.env.PUBLIC_URL ?? "https://hn.rlew.io"
)
  .replace(/\/+$/, "")
  .replace(/\/feed$/, "");
export const FEED_PATH = "/feed";
export const FEED_URL = `${PUBLIC_ORIGIN}${FEED_PATH}`;
export const REPO_URL = "https://github.com/ryanlewis/hn-summaries";

// Feed ordering, switchable via ?sort=.
//   "date"   — rolling stream, newest summary first. Keeps stories that recently fell off
//              the best list (until they're pruned at OFFLIST_RETENTION_MS), so the view
//              keeps moving as new summaries land.
//   "points" — the HN best-list ranking, on-list stories only. An entry vanishes the moment
//              the story leaves the best list.
// "date" is the default so a reader's view doesn't appear frozen on slow-moving top stories.
export const FEED_SORTS = ["date", "points"] as const;
export type FeedSort = (typeof FEED_SORTS)[number];
export const DEFAULT_FEED_SORT: FeedSort = "date";
// In the points view, a story is flagged "about to roll off" once its rank is within this
// many places of the bottom of the best list (~200 long), so subscribers see it coming.
export const ROLLOFF_WARN_BAND = 25;

// --- Cache ---
// On-disk cache location. Overridable via CACHE_PATH so local dev can point at a
// committed fixture (e.g. `fixtures/cache.sample.json`, resolved against the cwd)
// instead of the live data/cache.json next to the source. See `bun run dev`.
export const CACHE_PATH =
  process.env.CACHE_PATH ??
  fileURLToPath(new URL("../data/cache.json", import.meta.url));
export const CACHE_TMP_PATH = CACHE_PATH + ".tmp";
export const CACHE_VERSION = 1 as const;
// Keep summaries for stories that temporarily fall off the best list, so a story
// that bounces off and back isn't re-summarized. Off-list entries are pruned only
// once they've been gone this long (the best list's bottom churns hourly). Bounce-backs
// resolve within hours, so a few days is ample; the feed only ever serves the freshest
// MAX_FEED_COUNT anyway, so a longer tail is just unservable weight.
export const OFFLIST_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
// Hard ceiling on total cached stories — a *size* backstop beneath the time-based prune,
// so the cache can't balloon if churn spikes or the best list grows. On-list stories are
// always kept (the live working set + the points feed); when still over cap, off-list
// stories are evicted oldest-summary-first. Sized as on-list (~200) + a rolling off-list
// tail, kept just above MAX_FEED_COUNT so a full-depth date feed stays servable.
export const MAX_CACHE_STORIES = 250;
