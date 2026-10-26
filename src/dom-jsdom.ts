// jsdom-backed DOM helpers for the Bun service: Readability parsing for the article
// tiers, and HTML-to-text for HN comment / self-post bodies. The Worker uses the
// linkedom equivalents in dom-linkedom.ts.
import { JSDOM, VirtualConsole } from "jsdom";
import {
  commentMarkupForText,
  readableText,
  tidyText,
  type ExtractionResult,
} from "./extract.js";

/**
 * Run Readability over a chunk of HTML and return the readable text (or a fail
 * reason). Shared by the fetch path and the browser path (extract-browser.ts), so both
 * use one extraction implementation. `url` is the document base URL.
 */
export function htmlToArticleText(html: string, url: string): ExtractionResult {
  if (!html.trim()) return { ok: false, reason: "empty" };
  try {
    const dom = new JSDOM(html, {
      url,
      virtualConsole: new VirtualConsole(), // silent: no listeners attached
    });
    return readableText(dom.window.document);
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
  el.innerHTML = commentMarkupForText(html);
  const text: string = el.textContent ?? "";
  el.innerHTML = "";
  return tidyText(text);
}
