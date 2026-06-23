// Article fetching + readable-text extraction, plus an HTML-to-text helper for
// HN comment / self-post bodies. All jsdom/Readability DOM values are cast to
// `any` so the project type-checks without pulling the "DOM" lib (which would
// collide with Node's global fetch/Response types).
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import {
  ARTICLE_FETCH_TIMEOUT_MS,
  ARTICLE_MAX_BYTES,
  ARTICLE_TEXT_MAX_CHARS,
  BROWSER_FALLBACK_ENABLED,
  BROWSER_RECOVERABLE_REASONS,
  USER_AGENT,
} from "./config.js";

export type ExtractFailReason =
  | "non-html"
  | "too-large"
  | "timeout"
  | "error"
  | "empty";

export type ExtractionResult =
  | { ok: true; text: string }
  | { ok: false; reason: ExtractFailReason };

const BLOCKED_CONTENT_TYPES = [
  "application/pdf",
  "video/",
  "audio/",
  "image/",
  "application/octet-stream",
  "application/zip",
];

function isBlockedContentType(ct: string): boolean {
  const lc = ct.toLowerCase();
  return BLOCKED_CONTENT_TYPES.some((p) => lc.includes(p));
}

function isHtmlContentType(ct: string): boolean {
  const lc = ct.toLowerCase();
  return lc.includes("text/html") || lc.includes("application/xhtml");
}

export async function extractArticleText(
  url: string,
): Promise<ExtractionResult> {
  // Best-effort HEAD pre-check (many servers don't support HEAD — ignore failures).
  try {
    const head = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT },
    });
    if (head.ok) {
      const ct = head.headers.get("content-type") ?? "";
      if (ct && isBlockedContentType(ct)) return { ok: false, reason: "non-html" };
      // No content-length / too-large rejection here. The GET path below streams with
      // a hard byte cap and extracts the (partial) HTML, so a large-but-readable article
      // is still summarized rather than forced to a discussion-only fallback — which the
      // browser tier couldn't recover either, since "too-large" isn't browser-recoverable.
    }
  } catch {
    /* ignore — fall through to GET */
  }

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
      },
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, reason: name === "TimeoutError" ? "timeout" : "error" };
  }

  if (!res.ok) return { ok: false, reason: "error" };

  const ct = res.headers.get("content-type") ?? "";
  // If a content-type is present and it's clearly not HTML, bail to fallback.
  if (ct && !isHtmlContentType(ct)) return { ok: false, reason: "non-html" };

  // Stream the body with a hard byte cap so a giant page can't OOM us. Decode
  // incrementally with a streaming TextDecoder so a multibyte UTF-8 codepoint split
  // across a chunk boundary (or at the cap) isn't mangled into a replacement char.
  let html: string;
  try {
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, reason: "error" };
    const decoder = new TextDecoder("utf-8");
    html = "";
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (total > ARTICLE_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          break; // Readability copes with partial HTML
        }
      }
    }
    html += decoder.decode(); // flush any bytes still buffered in the decoder
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, reason: name === "TimeoutError" ? "timeout" : "error" };
  }

  if (!html.trim()) return { ok: false, reason: "empty" };

  return htmlToArticleText(html, url);
}

/**
 * Run Readability over a chunk of HTML and return the readable text (or a fail
 * reason). Shared by the fetch path above and the browser path (extract-browser.ts),
 * so both use one extraction implementation. `url` is the document base URL.
 */
export function htmlToArticleText(html: string, url: string): ExtractionResult {
  if (!html.trim()) return { ok: false, reason: "empty" };
  try {
    const dom = new JSDOM(html, {
      url,
      virtualConsole: new VirtualConsole(), // silent: no listeners attached
    });
    const article = new Readability(dom.window.document as any).parse() as
      | { textContent?: string }
      | null;
    const text = (article?.textContent ?? "").replace(/\s+\n/g, "\n").trim();
    if (!text) return { ok: false, reason: "empty" };
    return { ok: true, text: text.slice(0, ARTICLE_TEXT_MAX_CHARS) };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * Tiered extraction: try the plain fetch+Readability path first; if it fails with a
 * reason a real browser can plausibly recover (see BROWSER_RECOVERABLE_REASONS), render
 * the page with Bun.WebView and re-run Readability. Returns the fetch result unchanged
 * when the browser tier is disabled, not applicable, or also fails.
 */
export async function extractArticleTextTiered(
  url: string,
): Promise<ExtractionResult> {
  const fetched = await extractArticleText(url);
  if (fetched.ok) return fetched;

  if (
    !BROWSER_FALLBACK_ENABLED ||
    !(BROWSER_RECOVERABLE_REASONS as readonly string[]).includes(fetched.reason)
  ) {
    return fetched;
  }

  const { extractArticleViaBrowser } = await import("./extract-browser.js");
  const rendered = await extractArticleViaBrowser(url);
  if (rendered.ok) return rendered;

  // Both tiers failed — return the original fetch-path reason unchanged. It must stay one
  // of the ExtractFailReason literals: it's persisted as fallbackReason, tallied in
  // /status's byReason breakdown, and interpolated into the fallback summarization prompt.
  return fetched;
}

// --- HTML → plain text (HN comment & self-post bodies) ---
// One reusable scratch document. htmlToText runs fully synchronously (no await),
// so even under concurrent refresh workers there's no interleaving on it.
const scratchDoc: any = new JSDOM(
  "<!DOCTYPE html><body><div id='scratch'></div></body>",
  { virtualConsole: new VirtualConsole() },
).window.document;

export function htmlToText(html: string): string {
  const el = scratchDoc.getElementById("scratch");
  el.innerHTML = String(html)
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n");
  const text: string = el.textContent ?? "";
  el.innerHTML = "";
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
