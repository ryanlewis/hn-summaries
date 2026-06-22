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
