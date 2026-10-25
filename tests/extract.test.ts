// Extraction over the committed fixtures: the Worker's linkedom DOM must give the same
// text as the VM's jsdom, and the fetch tier's guards must route to the right outcome.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as jsdom from "../src/dom-jsdom.js";
import * as linkedom from "../src/dom-linkedom.js";
import { extractArticleTextTiered, type ExtractionResult } from "../src/extract.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/articles/${name}`, import.meta.url), "utf8");
const URL_ = "https://example.com/post";

describe("Readability over fixtures", () => {
  test("blog post: article text only, identical across DOMs", () => {
    const html = fixture("blog-post.html");
    const a = jsdom.htmlToArticleText(html, URL_);
    const b = linkedom.htmlToArticleText(html, URL_);
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
    const text = (b as { text: string }).text;
    expect(text).toContain("The cache is bounded twice.");
    expect(text).toContain("Bound everything, and make the bounds visible.");
    expect(text).not.toContain("Popular posts");
    expect(text).not.toContain("All rights reserved");
  });

  test("JS shell: empty on both DOMs", () => {
    const html = fixture("js-shell.html");
    expect(jsdom.htmlToArticleText(html, URL_)).toEqual({ ok: false, reason: "empty" });
    expect(linkedom.htmlToArticleText(html, URL_)).toEqual({ ok: false, reason: "empty" });
  });

  test("blank HTML is empty", () => {
    expect(linkedom.htmlToArticleText("  \n", URL_)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("htmlToText (HN comment bodies)", () => {
  const samples = [
    "Plain text with &amp; entities &lt;b&gt; &#x27;quoted&#x27;",
    "First paragraph.<p>Second paragraph with <a href=\"https://x.test\" rel=\"nofollow\">a link</a>.<p>Third.",
    "<pre><code>  indented code\n  more</code></pre><p>after code",
    "line one<br>line two<br/>line three",
    "<i>emphasis</i> and a stray &gt; sign",
  ];
  for (const s of samples) {
    test(`same text across DOMs: ${s.slice(0, 30)}`, () => {
      expect(linkedom.htmlToText(s)).toBe(jsdom.htmlToText(s));
    });
  }
});

describe("tiered extraction (fetch guards)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function serve(body: string | Uint8Array, init: ResponseInit) {
    globalThis.fetch = (async (_url: unknown, opts?: RequestInit) => {
      if (opts?.method === "HEAD") return new Response(null, init);
      return new Response(body, init);
    }) as typeof fetch;
  }

  let renders: string[];
  const render = async (url: string): Promise<ExtractionResult> => {
    renders.push(url);
    return linkedom.htmlToArticleText(fixture("blog-post.html"), url);
  };

  test("readable HTML is extracted without the browser tier", async () => {
    renders = [];
    serve(fixture("blog-post.html"), { headers: { "content-type": "text/html; charset=utf-8" } });
    const r = await extractArticleTextTiered(URL_, linkedom.htmlToArticleText, render);
    expect(r.ok).toBe(true);
    expect(renders).toEqual([]);
  });

  test("a JS shell falls through to the browser tier", async () => {
    renders = [];
    serve(fixture("js-shell.html"), { headers: { "content-type": "text/html" } });
    const r = await extractArticleTextTiered(URL_, linkedom.htmlToArticleText, render);
    expect(renders).toEqual([URL_]);
    expect(r.ok).toBe(true);
  });

  test("an HTTP error tries the browser tier, and keeps the fetch reason if it fails too", async () => {
    renders = [];
    serve("nope", { status: 503, headers: { "content-type": "text/html" } });
    const failing = async (url: string): Promise<ExtractionResult> => {
      renders.push(url);
      return { ok: false, reason: "empty" };
    };
    const r = await extractArticleTextTiered(URL_, linkedom.htmlToArticleText, failing);
    expect(renders).toEqual([URL_]);
    expect(r).toEqual({ ok: false, reason: "error" });
  });

  test("a PDF is non-html and never rendered", async () => {
    renders = [];
    serve(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } });
    const r = await extractArticleTextTiered(URL_, linkedom.htmlToArticleText, render);
    expect(r).toEqual({ ok: false, reason: "non-html" });
    expect(renders).toEqual([]);
  });

  test("no browser tier: the fetch reason is returned", async () => {
    serve(fixture("js-shell.html"), { headers: { "content-type": "text/html" } });
    const r = await extractArticleTextTiered(URL_, linkedom.htmlToArticleText);
    expect(r).toEqual({ ok: false, reason: "empty" });
  });
});
