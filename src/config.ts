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

// --- Refresh / pipeline ---
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // hourly
export const CONCURRENCY_LIMIT = 5; // parallel fetch+summarize workers
// Hard cap on how many NEW stories are summarized per refresh cycle. Steady-state
// churn is well under this, so it never bites normally — it's a cost backstop so a
// wiped cache can't silently re-summarize the whole list in one hour. Excess
// stories are picked up on subsequent refreshes.
export const MAX_NEW_PER_REFRESH = 60;

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
export const CACHE_PATH = fileURLToPath(
  new URL("../data/cache.json", import.meta.url),
);
export const CACHE_TMP_PATH = CACHE_PATH + ".tmp";
export const CACHE_VERSION = 1 as const;
// Keep summaries for stories that temporarily fall off the best list, so a story
// that bounces off and back isn't re-summarized. Off-list entries are pruned only
// once they've been gone this long (the best list's bottom churns hourly).
export const OFFLIST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
