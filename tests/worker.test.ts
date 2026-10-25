// The Worker's own pieces: the gateway provider seam, the Browser Rendering budget, and
// the shared refresh pipeline driven through injected deps (as the cron does).
import { afterEach, describe, expect, test } from "bun:test";
import type { CacheFile } from "../src/cache.js";
import { MIN_POINTS_TO_SUMMARIZE } from "../src/config.js";
import { htmlToText } from "../src/dom-linkedom.js";
import { refreshState, runRefresh, type RefreshDeps } from "../src/refresh.js";
import { browserRenderer, type BrowserBudget } from "../src/worker/browser.js";
import { gatewayModelId, gatewaySummarizer, responseText } from "../src/worker/summarize.js";

const input = { title: "T", url: "https://x.test", articleText: "body", commentsText: "" };

describe("gateway summarizer", () => {
  test("model ids per provider", () => {
    expect(gatewayModelId("workers-ai", "@cf/a/b")).toBe("@cf/a/b");
    expect(gatewayModelId("openai", "gpt-x")).toBe("openai/gpt-x");
    expect(gatewayModelId("anthropic", "claude-y")).toBe("anthropic/claude-y");
  });

  test("response shapes", () => {
    expect(responseText({ response: " a " })).toBe("a");
    expect(responseText({ choices: [{ message: { content: " b" } }] })).toBe("b");
    expect(responseText({ content: [{ type: "text", text: "c" }, { type: "thinking" }] })).toBe("c");
    expect(responseText(null)).toBe("");
  });

  test("workers-ai call: system + user prompt, cap, gateway, no cache", async () => {
    const calls: any[] = [];
    const s = gatewaySummarizer(
      { run: async (...a: any[]) => (calls.push(a), { response: "ok" }) },
      "workers-ai",
      "@cf/m",
    );
    expect(await s(input)).toBe("ok");
    const [model, inputs, opts] = calls[0];
    expect(model).toBe("@cf/m");
    expect(inputs.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
    expect(inputs.messages[1].content).toContain("ARTICLE TEXT");
    expect(inputs.max_tokens).toBeGreaterThan(0);
    expect(opts.gateway.skipCache).toBe(true);
    expect(typeof opts.gateway.id).toBe("string");
  });

  test("third-party call sends no max_tokens", async () => {
    const calls: any[] = [];
    const s = gatewaySummarizer(
      { run: async (...a: any[]) => (calls.push(a), { choices: [{ message: { content: "ok" } }] }) },
      "openai",
      "gpt-x",
    );
    await s(input);
    expect(calls[0][0]).toBe("openai/gpt-x");
    expect("max_tokens" in calls[0][1]).toBe(false);
  });
});

describe("browser renderer budget", () => {
  const html = "<html><body><article><p>" + "Rendered paragraph text. ".repeat(40) + "</p></article></body></html>";
  const ok = (ms: string) =>
    new Response(JSON.stringify({ success: true, result: html }), {
      headers: { "content-type": "application/json", "x-browser-ms-used": ms },
    });

  test("renders, counts browser time, stops at the budget, resets next day", async () => {
    let now = Date.parse("2026-10-25T10:00:00Z");
    let calls = 0;
    const budget: BrowserBudget = { day: "", msUsed: 0 };
    const render = browserRenderer(
      { quickAction: async () => (calls++, ok("6000")) },
      budget,
      10_000,
      () => now,
    );
    expect((await render("https://a.test")).ok).toBe(true);
    expect(budget).toEqual({ day: "2026-10-25", msUsed: 6000 });
    expect((await render("https://b.test")).ok).toBe(true); // 6000 < 10000, so allowed
    expect((await render("https://c.test")).ok).toBe(false); // 12000 >= budget
    expect(calls).toBe(2);
    now += 24 * 60 * 60 * 1000;
    expect((await render("https://d.test")).ok).toBe(true);
    expect(budget).toEqual({ day: "2026-10-26", msUsed: 6000 });
  });

  test("errors fail cleanly and still count time", async () => {
    const budget: BrowserBudget = { day: "", msUsed: 0 };
    const render = browserRenderer(
      { quickAction: async () => new Response("{}", { status: 422, headers: { "x-browser-ms-used": "900" } }) },
      budget,
    );
    expect(await render("https://a.test")).toEqual({ ok: false, reason: "error" });
    expect(budget.msUsed).toBe(900);
  });
});

describe("refresh pipeline with Worker-style deps", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Best list of 4: two above the points gate, one below, one HN won't serve.
  const items: Record<number, object | null> = {
    1: { id: 1, type: "story", title: "One", url: "https://one.test", score: MIN_POINTS_TO_SUMMARIZE + 50, by: "a", time: 1, descendants: 2, kids: [11] },
    2: { id: 2, type: "story", title: "Two", text: "<p>self post</p>", score: MIN_POINTS_TO_SUMMARIZE, by: "b", time: 2, descendants: 0 },
    3: { id: 3, type: "story", title: "Three", url: "https://three.test", score: MIN_POINTS_TO_SUMMARIZE - 1, by: "c", time: 3, descendants: 0 },
    4: null,
    11: { id: 11, type: "comment", text: "nice &amp; tidy" },
  };
  function stubHN() {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/beststories.json")) return Response.json([1, 2, 3, 4]);
      const id = Number(u.match(/item\/(\d+)\.json/)?.[1]);
      return Response.json(items[id] ?? null);
    }) as typeof fetch;
  }

  function memoryDeps(over: Partial<RefreshDeps> = {}) {
    let saved: CacheFile = { version: 1, updatedAt: 0, stories: {} };
    const prompts: string[] = [];
    const deps: RefreshDeps = {
      loadCache: async () => saved,
      saveCache: async (c) => {
        saved = c;
      },
      extractArticle: async () => ({ ok: true, text: "article" }),
      htmlToText,
      summarize: async (i) => (prompts.push(i.commentsText), `summary of ${i.title}`),
      ...over,
    };
    return { deps, prompts, get saved() { return saved; } };
  }

  test("gates by points, summarizes, saves", async () => {
    stubHN();
    const m = memoryDeps();
    await runRefresh(m.deps);
    expect(Object.keys(m.saved.stories).sort()).toEqual(["1", "2"]);
    expect(m.saved.stories["1"]!.summary).toBe("summary of One");
    expect(m.saved.stories["2"]!.isFallback).toBe(false); // self-post text counts as the article
    expect(m.prompts).toContain("- nice & tidy");
    expect(refreshState.lastGatedByPoints).toBe(1);
    expect(refreshState.lastGatedNoMetadata).toBe(1);
    expect(refreshState.lastError).toBeNull();
  });

  test("past the deadline nothing new starts, and the cache is still saved", async () => {
    stubHN();
    const m = memoryDeps({ deadlineAt: Date.now() - 1 });
    await runRefresh(m.deps);
    expect(m.saved.stories).toEqual({});
    expect(m.saved.updatedAt).toBeGreaterThan(0);
    expect(refreshState.lastDeferredByDeadline).toBe(2);
  });

  test("a fallback is retried and recovered on the next cycle", async () => {
    stubHN();
    let extractOk = false;
    const m = memoryDeps({
      extractArticle: async () =>
        extractOk ? { ok: true, text: "article" } : { ok: false, reason: "timeout" },
    });
    await runRefresh(m.deps);
    expect(m.saved.stories["1"]!.isFallback).toBe(true);
    extractOk = true;
    await runRefresh(m.deps);
    expect(m.saved.stories["1"]!.isFallback).toBe(false);
    expect(refreshState.lastRecoveredCount).toBe(1);
  });
});
