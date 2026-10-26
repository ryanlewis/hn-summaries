// Entrypoint: start the HTTP server, run an initial refresh, then refresh hourly.
import { loadCache, saveCache } from "./src/cache.js";
import {
  BROWSER_FALLBACK_ENABLED,
  REFRESH_DISABLED,
  REFRESH_INTERVAL_MS,
} from "./src/config.js";
import { htmlToArticleText, htmlToText } from "./src/dom-jsdom.js";
import { ensureChromePath, extractArticleViaBrowser } from "./src/extract-browser.js";
import { extractArticleTextTiered } from "./src/extract.js";
import { runRefresh, type RefreshDeps } from "./src/refresh.js";
import { startServer } from "./src/server.js";
import { summarize } from "./src/summarize.js";

const deps: RefreshDeps = {
  loadCache,
  saveCache,
  extractArticle: (url) =>
    extractArticleTextTiered(
      url,
      htmlToArticleText,
      BROWSER_FALLBACK_ENABLED ? extractArticleViaBrowser : undefined,
    ),
  htmlToText,
  summarize,
};

async function main(): Promise<void> {
  // Serve immediately (returns 503 on /feed until the cache has stories).
  startServer();

  // Local dev: serve whatever's in the cache (typically a CACHE_PATH fixture) and skip
  // the network pipeline entirely. No browser tier needed, so don't resolve Chrome either.
  if (REFRESH_DISABLED) {
    console.log("[main] REFRESH_DISABLED — serving the cache without refreshing");
    return;
  }

  // Resolve the browser binary up front so the chosen path (or its absence) is logged
  // at boot, not lazily on the first fallback render.
  ensureChromePath();

  // Kick off the first refresh, then schedule subsequent ones.
  await runRefresh(deps);
  setInterval(() => {
    void runRefresh(deps);
  }, REFRESH_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});

// Don't let a stray rejection kill the process; the next refresh will retry.
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection:", reason);
});
