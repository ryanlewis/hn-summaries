// Article fetching + readable-text extraction. Runtime-neutral: the DOM used for
// Readability is supplied by the caller (`parse`), so the Bun service plugs in jsdom
// (dom-jsdom.ts) and the Worker plugs in linkedom (dom-linkedom.ts). All DOM values are
// cast to `any` so the project type-checks without pulling the "DOM" lib (which would
// collide with Node's global fetch/Response types).
import { Readability } from "@mozilla/readability";
import {
  ARTICLE_FETCH_TIMEOUT_MS,
  ARTICLE_MAX_BYTES,
  ARTICLE_TEXT_MAX_CHARS,
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

/** Readability over a chunk of HTML; `url` is the document base URL. */
export type ParseArticle = (html: string, url: string) => ExtractionResult;
/** Render a page in a real browser and extract it (the fallback tier). */
export type RenderArticle = (url: string) => Promise<ExtractionResult>;

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
  parse: ParseArticle,
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

  return parse(html, url);
}

/**
 * Run Readability over an already-parsed document and return the readable text (or a
 * fail reason). The one extraction implementation behind every ParseArticle, whichever
 * DOM built `document`.
 */
export function readableText(document: unknown): ExtractionResult {
  try {
    const article = new Readability(document as any).parse() as
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
 * the page with `render` (Bun.WebView on the VM, Browser Rendering on the Worker).
 * Returns the fetch result unchanged when there is no `render` (tier disabled), the
 * reason isn't recoverable, or the render also fails.
 */
export async function extractArticleTextTiered(
  url: string,
  parse: ParseArticle,
  render?: RenderArticle,
): Promise<ExtractionResult> {
  const fetched = await extractArticleText(url, parse);
  if (fetched.ok) return fetched;

  if (
    !render ||
    !(BROWSER_RECOVERABLE_REASONS as readonly string[]).includes(fetched.reason)
  ) {
    return fetched;
  }

  const rendered = await render(url);
  if (rendered.ok) return rendered;

  // Both tiers failed — return the original fetch-path reason unchanged. It must stay one
  // of the ExtractFailReason literals: it's persisted as fallbackReason, tallied in
  // /status's byReason breakdown, and interpolated into the fallback summarization prompt.
  return fetched;
}

/** Pre-clean an HN comment / self-post body so block breaks survive textContent. */
export function commentMarkupForText(html: string): string {
  return String(html)
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n");
}

/** Collapse the blank-line runs textContent leaves behind. */
export function tidyText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
