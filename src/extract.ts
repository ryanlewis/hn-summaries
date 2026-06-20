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
      const cl = head.headers.get("content-length");
      if (cl && Number(cl) > ARTICLE_MAX_BYTES)
        return { ok: false, reason: "too-large" };
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

  // Stream the body with a hard byte cap so a giant page can't OOM us.
  let html: string;
  try {
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, reason: "error" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total > ARTICLE_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          break; // Readability copes with partial HTML
        }
      }
    }
    html = Buffer.concat(chunks).toString("utf8");
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, reason: name === "TimeoutError" ? "timeout" : "error" };
  }

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
