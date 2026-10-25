// Cloudflare Worker entry: serves the feed from KV and refreshes it on an hourly cron.
// The refresh pipeline, routes and renderers are the same modules the Bun service uses;
// this file only wires in the Worker's storage, DOM, browser tier and model gateway.
import { getStories } from "../cache.js";
import {
  BROWSER_DAILY_BUDGET_MS,
  GATEWAY_MODEL,
  WORKER_RUN_BUDGET_MS,
} from "../config.js";
import { htmlToArticleText, htmlToText } from "../dom-linkedom.js";
import { extractArticleTextTiered } from "../extract.js";
import { refreshState, runRefresh } from "../refresh.js";
import { route } from "../routes.js";
import { browserRenderer, type BrowserBudget } from "./browser.js";
import {
  CACHE_KEY,
  STATUS_KEY,
  loadCacheFile,
  loadStatus,
  type StoredStatus,
} from "./store.js";
import { gatewaySummarizer } from "./summarize.js";

const summaryModel = GATEWAY_MODEL.replace(/^@cf\//, "");

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const [cache, status] = await Promise.all([
      loadCacheFile(env.CACHE),
      url.pathname === "/status" ? loadStatus(env.CACHE) : null,
    ]);
    const out = route(url, {
      stories: getStories(cache),
      updatedAt: cache.updatedAt,
      state: status?.state ?? refreshState,
      summaryModel,
      extraHeadHtml: process.env.EXTRA_HEAD_HTML,
    });
    return new Response(out.body, { status: out.status, headers: out.headers });
  },

  async scheduled(_controller, env): Promise<void> {
    // The isolate may be fresh: carry the counters (totalRefreshes, lastRefreshAt) and
    // the browser budget over from the last run.
    const stored = await loadStatus(env.CACHE);
    if (stored) Object.assign(refreshState, stored.state);
    refreshState.running = false;
    const browser: BrowserBudget = stored?.browser ?? { day: "", msUsed: 0 };
    const render =
      BROWSER_DAILY_BUDGET_MS > 0 ? browserRenderer(env.BROWSER, browser) : undefined;

    await runRefresh({
      loadCache: () => loadCacheFile(env.CACHE),
      saveCache: (cache) => env.CACHE.put(CACHE_KEY, JSON.stringify(cache)),
      extractArticle: (url) => extractArticleTextTiered(url, htmlToArticleText, render),
      htmlToText,
      summarize: gatewaySummarizer(env.AI),
      deadlineAt: Date.now() + WORKER_RUN_BUDGET_MS,
    });

    const next: StoredStatus = { state: refreshState, browser };
    await env.CACHE.put(STATUS_KEY, JSON.stringify(next));
  },
} satisfies ExportedHandler<Env>;
