// Entrypoint: start the HTTP server, run an initial refresh, then refresh hourly.
import { REFRESH_INTERVAL_MS } from "./src/config.js";
import { runRefresh } from "./src/refresh.js";
import { startServer } from "./src/server.js";

async function main(): Promise<void> {
  // Serve immediately (returns 503 on /feed until the first refresh populates the cache).
  startServer();

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
