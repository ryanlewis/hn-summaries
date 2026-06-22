// Minimal HTTP server: /, /feed, /healthz, /status.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FEED_COUNT,
  MAX_FEED_COUNT,
  PORT,
  REFRESH_INTERVAL_MS,
} from "./config.js";
import { getStories, loadCache } from "./cache.js";
import { buildFeedXml } from "./feed.js";
import { buildLandingPage } from "./page.js";
import { refreshState } from "./refresh.js";

const startedAt = Date.now();

// Static favicon assets, loaded once at startup from app/public/.
const STATIC_ASSETS: Record<string, { body: Buffer; type: string }> = (() => {
  const dir = fileURLToPath(new URL("../public/", import.meta.url));
  const files: Array<[string, string]> = [
    ["/favicon.ico", "image/x-icon"],
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon-180.png", "image/png"],
    ["/favicon-32.png", "image/png"],
  ];
  const map: Record<string, { body: Buffer; type: string }> = {};
  for (const [route, type] of files) {
    try {
      map[route] = { body: readFileSync(dir + route.slice(1)), type };
    } catch {
      /* asset missing — skip */
    }
  }
  return map;
})();

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function intParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  const asset = STATIC_ASSETS[url.pathname];
  if (asset) {
    res.writeHead(200, {
      "content-type": asset.type,
      "cache-control": "public, max-age=604800",
    });
    res.end(asset.body);
    return;
  }

  const cache = await loadCache();
  const stories = getStories(cache);

  if (url.pathname === "/healthz") {
    return sendJson(res, 200, {
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      cachedStories: stories.length,
    });
  }

  if (url.pathname === "/status") {
    // Fallback breakdown over the stories that actually appear in the feed (on-list),
    // for measuring extraction quality / the browser-tier's effect before vs. after.
    const onList = stories.filter((s) => s.onList !== false);
    const fallbackStories = onList.filter((s) => s.isFallback);
    const byReason: Record<string, number> = {};
    for (const s of fallbackStories) {
      const reason = s.fallbackReason ?? "unknown";
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
    const fallbacks = {
      onList: onList.length,
      count: fallbackStories.length,
      percent: onList.length
        ? Math.round((1000 * fallbackStories.length) / onList.length) / 10
        : 0,
      byReason,
    };
    const nextIn = refreshState.lastRefreshAt
      ? Math.max(
          0,
          Math.round(
            (refreshState.lastRefreshAt + REFRESH_INTERVAL_MS - Date.now()) /
              1000,
          ),
        )
      : null;
    return sendJson(res, 200, {
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      cachedStories: stories.length,
      lastRefreshAt: refreshState.lastRefreshAt
        ? new Date(refreshState.lastRefreshAt).toISOString()
        : null,
      lastRefreshDurationMs: refreshState.lastDurationMs,
      lastNewSummaries: refreshState.lastNewCount,
      totalRefreshes: refreshState.totalRefreshes,
      refreshRunning: refreshState.running,
      nextRefreshInSeconds: nextIn,
      lastError: refreshState.lastError,
      fallbacks,
    });
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = buildLandingPage(stories, {
      updatedAt: cache.updatedAt,
      totalCount: stories.length,
    });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    });
    res.end(html);
    return;
  }

  if (url.pathname === "/feed" || url.pathname === "/feed.xml") {
    if (stories.length === 0) {
      res.writeHead(503, {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": "60",
      });
      res.end("Feed warming up — first batch of summaries is generating. Try again shortly.");
      return;
    }
    const count = clamp(
      intParam(url.searchParams.get("count"), DEFAULT_FEED_COUNT),
      1,
      MAX_FEED_COUNT,
    );
    const minPoints = clamp(
      intParam(url.searchParams.get("min_points"), 0),
      0,
      1_000_000,
    );
    const xml = buildFeedXml(stories, {
      count,
      minPoints,
      updatedAt: cache.updatedAt,
    });
    res.writeHead(200, {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=300",
    });
    res.end(xml);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found. Try / for usage or /feed for the RSS feed.");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

export function startServer(): void {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[server] handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("Internal server error");
    });
  });
  server.listen(PORT, () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  });
}
