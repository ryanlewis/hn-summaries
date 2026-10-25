// The Worker's browser tier: Cloudflare Browser Rendering's /content Quick Action
// renders the page, and the rendered HTML goes through the same Readability path as the
// fetch tier. Reached only for fetch failures a renderer can plausibly recover (see
// extractArticleTextTiered), under its own concurrency cap and a daily time budget that
// keeps usage inside the plan's included browser hours.
import pLimit from "p-limit";
import {
  BROWSER_CONCURRENCY,
  BROWSER_DAILY_BUDGET_MS,
  BROWSER_TIMEOUT_MS,
} from "../config.js";
import { htmlToArticleText } from "../dom-linkedom.js";
import type { ExtractionResult, RenderArticle } from "../extract.js";

/** Browser time used on one UTC day. Persisted with the refresh telemetry in KV. */
export interface BrowserBudget {
  day: string; // YYYY-MM-DD (UTC)
  msUsed: number;
}

// The parts of the BrowserRun binding this tier uses (a stub in tests).
export interface ContentRenderer {
  quickAction(action: "content", options: BrowserRunContentOptions): Promise<Response>;
}

const FAILED: ExtractionResult = { ok: false, reason: "error" };

export function browserRenderer(
  browser: ContentRenderer,
  budget: BrowserBudget,
  budgetMs: number = BROWSER_DAILY_BUDGET_MS,
  now: () => number = Date.now,
): RenderArticle {
  const limit = pLimit(BROWSER_CONCURRENCY);
  return (url) =>
    limit(async () => {
      const today = new Date(now()).toISOString().slice(0, 10);
      if (budget.day !== today) {
        budget.day = today;
        budget.msUsed = 0;
      }
      if (budget.msUsed >= budgetMs) return FAILED;

      let res: Response;
      try {
        res = await browser.quickAction("content", {
          url,
          gotoOptions: { waitUntil: "networkidle2", timeout: BROWSER_TIMEOUT_MS },
          // Text is all Readability needs; skipping the rest saves browser time.
          rejectResourceTypes: ["image", "media", "font", "stylesheet"],
        });
      } catch {
        budget.msUsed += BROWSER_TIMEOUT_MS; // unknown usage: assume the worst
        return FAILED;
      }
      // Set on every response below 500. Without it, count the timeout so a run of
      // failures can't spend past the budget unseen.
      const used = Number(res.headers.get("x-browser-ms-used"));
      budget.msUsed += Number.isFinite(used) && used >= 0 ? used : BROWSER_TIMEOUT_MS;

      if (!res.ok) {
        await res.body?.cancel();
        return FAILED;
      }
      try {
        const body = (await res.json()) as { success?: boolean; result?: unknown };
        if (!body.success || typeof body.result !== "string") return FAILED;
        return htmlToArticleText(body.result, url);
      } catch {
        return FAILED;
      }
    });
}
