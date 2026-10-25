// Request routing shared by the Bun server (server.ts) and the Worker
// (src/worker/index.ts): /, /feed, /healthz, /status, /robots.txt. Pure: takes the
// cached stories and refresh telemetry, returns a status, headers and body. Static
// assets are served by each runtime (node:http on the VM, Workers static assets).
import {
  DEFAULT_FEED_COUNT,
  DEFAULT_FEED_SORT,
  FEED_SORTS,
  type FeedSort,
  MAX_CACHE_STORIES,
  MAX_FEED_COUNT,
  MIN_POINTS_TO_SUMMARIZE,
  REFRESH_INTERVAL_MS,
} from "./config.js";
import type { CachedStory } from "./cache.js";
import { buildFeedXml } from "./feed.js";
import { buildLandingPage } from "./page.js";
import type { RefreshState } from "./refresh.js";

export interface RouteContext {
  stories: CachedStory[];
  updatedAt: number; // the cache's updatedAt
  state: RefreshState;
  summaryModel: string; // named in the landing-page footer
  extraHeadHtml?: string; // raw operator HTML for the landing-page <head>
  // Process-lifetime fields: the Bun server has them, a Worker doesn't. Left undefined,
  // they are omitted from /healthz and /status.
  uptimeSeconds?: number;
  refreshRunning?: boolean;
}

export interface RouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function intParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function sortParam(value: string | null): FeedSort {
  return (FEED_SORTS as readonly string[]).includes(value ?? "")
    ? (value as FeedSort)
    : DEFAULT_FEED_SORT;
}

function json(status: number, body: unknown): RouteResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body, null, 2),
  };
}

export function route(url: URL, ctx: RouteContext): RouteResponse {
  const { stories, state } = ctx;

  if (url.pathname === "/robots.txt") {
    // Fully public feed — allow everything. (No sitemap: it's a single landing page.)
    return {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
      body: "User-agent: *\nAllow: /\n",
    };
  }

  if (url.pathname === "/healthz") {
    return json(200, {
      status: "ok",
      uptimeSeconds: ctx.uptimeSeconds,
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
    const nextIn = state.lastRefreshAt
      ? Math.max(
          0,
          Math.round(
            (state.lastRefreshAt + REFRESH_INTERVAL_MS - Date.now()) / 1000,
          ),
        )
      : null;
    return json(200, {
      status: "ok",
      uptimeSeconds: ctx.uptimeSeconds,
      cachedStories: stories.length,
      cache: {
        total: stories.length,
        onList: onList.length,
        offList: stories.length - onList.length,
        cap: MAX_CACHE_STORIES,
      },
      lastRefreshAt: state.lastRefreshAt
        ? new Date(state.lastRefreshAt).toISOString()
        : null,
      lastRefreshDurationMs: state.lastDurationMs,
      lastNewSummaries: state.lastNewCount,
      lastRecoveredFallbacks: state.lastRecoveredCount,
      lastPruned: state.lastPruned,
      lastEvicted: state.lastEvicted,
      lastScoreUpdates: state.lastScoreUpdates,
      lastGatedByPoints: state.lastGatedByPoints,
      lastGatedNoMetadata: state.lastGatedNoMetadata,
      lastDeferredByDeadline: state.lastDeferredByDeadline,
      lastMetadataMisses: state.lastMetadataMisses,
      minPointsToSummarize: MIN_POINTS_TO_SUMMARIZE,
      totalRefreshes: state.totalRefreshes,
      refreshRunning: ctx.refreshRunning,
      nextRefreshInSeconds: nextIn,
      lastError: state.lastError,
      fallbacks,
    });
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = buildLandingPage(stories, {
      updatedAt: ctx.updatedAt,
      totalCount: stories.length,
      sort: sortParam(url.searchParams.get("sort")),
      summaryModel: ctx.summaryModel,
      extraHeadHtml: ctx.extraHeadHtml,
    });
    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
      body: html,
    };
  }

  if (url.pathname === "/feed" || url.pathname === "/feed.xml") {
    const sort = sortParam(url.searchParams.get("sort"));
    // Warm-up = "no servable stories yet" rather than "cache literally empty". The points
    // view serves on-list stories only, so it's cold until something is on the list; the
    // rolling date view can serve anything cached. Either way, return a retryable 503 rather
    // than a valid-but-itemless feed while the first batch of summaries is still generating.
    const warming =
      sort === "points"
        ? !stories.some((s) => s.onList !== false)
        : stories.length === 0;
    if (warming) {
      return {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": "60",
        },
        body: "Feed warming up — first batch of summaries is generating. Try again shortly.",
      };
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
      sort,
      updatedAt: ctx.updatedAt,
    });
    return {
      status: 200,
      headers: {
        "content-type": "application/rss+xml; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
      body: xml,
    };
  }

  return {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: "Not found. Try / for usage or /feed for the RSS feed.",
  };
}
