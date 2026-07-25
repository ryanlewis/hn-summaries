// Entrypoint: start the HTTP server, run an initial refresh, then refresh hourly.
import { REFRESH_DISABLED, REFRESH_INTERVAL_MS } from "./src/config.js";
import { ensureChromePath } from "./src/extract-browser.js";
import { runRefresh } from "./src/refresh.js";
import { startServer } from "./src/server.js";

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
  await runRefresh();
  setInterval(() => {
    void runRefresh();
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
