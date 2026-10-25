// linkedom-backed DOM helpers for the Worker, the Workers-compatible counterpart of
// dom-jsdom.ts (jsdom needs Node internals workerd doesn't have). Readability gives the
// same text over either DOM: identical output on 23 of 23 real best-list articles when
// this was written (docs/workers-migration.md), at a fraction of the CPU.
import { parseHTML } from "linkedom";
import {
  commentMarkupForText,
  readableText,
  tidyText,
  type ExtractionResult,
} from "./extract.js";

export function htmlToArticleText(html: string, _url: string): ExtractionResult {
  if (!html.trim()) return { ok: false, reason: "empty" };
  try {
    return readableText(parseHTML(html).document);
  } catch {
    return { ok: false, reason: "error" };
  }
}

export function htmlToText(html: string): string {
  const { document } = parseHTML("<!DOCTYPE html><html><body></body></html>");
  const el: any = document.body;
  el.innerHTML = commentMarkupForText(html);
  return tidyText(el.textContent ?? "");
}
