// Feed compatibility: GUIDs, query params and warm-up, rendered through the routes
// both runtimes share, over the committed sample cache.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getStories, type CacheFile } from "../src/cache.js";
import { refreshState } from "../src/refresh.js";
import { route } from "../src/routes.js";

const cache = JSON.parse(
  readFileSync(new URL("../fixtures/cache.sample.json", import.meta.url), "utf8"),
) as CacheFile;
const stories = getStories(cache);
const ctx = { stories, updatedAt: cache.updatedAt, state: refreshState, summaryModel: "test-model" };
const get = (path: string, c = ctx) => route(new URL(`https://hn.rlew.io${path}`), c);
const guids = (xml: string) =>
  [...xml.matchAll(/<guid isPermaLink="false">([^<]+)<\/guid>/g)].map((m) => m[1]);

describe("/feed", () => {
  test("every GUID is the HN item URL, one per story", () => {
    const res = get("/feed?count=200");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/rss+xml; charset=utf-8");
    const ids = guids(res.body);
    expect(ids.length).toBe(stories.length);
    expect(new Set(ids)).toEqual(
      new Set(stories.map((s) => `https://news.ycombinator.com/item?id=${s.id}`)),
    );
  });

  test("the same story has the same GUID in both sorts", () => {
    const date = new Set(guids(get("/feed?count=200").body));
    for (const g of guids(get("/feed?sort=points&count=200").body)) {
      expect(date.has(g)).toBe(true);
    }
  });

  test("points sort is on-list only, in rank order", () => {
    const onList = stories.filter((s) => s.onList !== false).sort((a, b) => a.rank - b.rank);
    expect(guids(get("/feed?sort=points&count=200").body)).toEqual(
      onList.map((s) => `https://news.ycombinator.com/item?id=${s.id}`),
    );
  });

  test("count and min_points filter", () => {
    expect(guids(get("/feed?count=3").body).length).toBe(3);
    const min = 500;
    expect(guids(get(`/feed?count=200&min_points=${min}`).body).length).toBe(
      stories.filter((s) => s.score >= min).length,
    );
  });

  test("/feed.xml is the same feed", () => {
    expect(get("/feed.xml").body).toBe(get("/feed").body);
  });

  test("503 while the cache is empty", () => {
    const res = get("/feed", { ...ctx, stories: [] });
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("60");
  });
});

describe("other routes", () => {
  test("/status omits process-only fields when not given", () => {
    const body = JSON.parse(get("/status").body);
    expect(body.cache.total).toBe(stories.length);
    expect("uptimeSeconds" in body).toBe(false);
    expect("refreshRunning" in body).toBe(false);
  });

  test("landing page names the model and carries the head HTML", () => {
    const res = get("/", { ...ctx, extraHeadHtml: "<meta name=x-test>" } as typeof ctx);
    expect(res.body).toContain("summaries by test-model");
    expect(res.body).toContain("<meta name=x-test>");
  });

  test("robots and 404", () => {
    expect(get("/robots.txt").body).toBe("User-agent: *\nAllow: /\n");
    expect(get("/nope").status).toBe(404);
  });
});
