// Tiered fallback extraction via a real browser (Bun.WebView). Renders the page so
// JS-built content and soft anti-bot pages produce a populated DOM, then hands the
// rendered HTML to the shared Readability path in extract.ts. Heavy compared to fetch,
// so it runs under its own concurrency cap, separate from the main refresh workers, and
// is only reached for fetch-path failures the renderer can plausibly recover.
//
// On Linux, Bun.WebView drives an installed Chrome/Chromium over CDP; the binary is
// found via $BUN_CHROME_PATH / $PATH / system locations / the Playwright cache.
import pLimit from "p-limit";
import {
  BROWSER_CONCURRENCY,
  BROWSER_SETTLE_MS,
  BROWSER_TIMEOUT_MS,
  BROWSER_VIEWPORT_HEIGHT,
  BROWSER_VIEWPORT_WIDTH,
} from "./config.js";
import { htmlToArticleText, type ExtractionResult } from "./extract.js";

// Throttle browser renders independently of CONCURRENCY_LIMIT: each WebView spawns a
// renderer process, so we keep far fewer of these in flight than plain fetches.
const limit = pLimit(BROWSER_CONCURRENCY);

let shutdownHooked = false;
function ensureShutdownHook(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const closeAll = () => {
    try {
      Bun.WebView.closeAll();
    } catch {
      /* ignore */
    }
  };
  process.on("exit", closeAll);
  process.on("SIGTERM", () => {
    closeAll();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    closeAll();
    process.exit(0);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Render `url` in a headless browser and extract readable text from the rendered DOM. */
export function extractArticleViaBrowser(url: string): Promise<ExtractionResult> {
  return limit(async () => {
    if (typeof Bun === "undefined" || typeof Bun.WebView !== "function") {
      return { ok: false, reason: "error" }; // not running under a WebView-capable Bun
    }
    ensureShutdownHook();

    const view = new Bun.WebView({
      backend: "chrome",
      width: BROWSER_VIEWPORT_WIDTH,
      height: BROWSER_VIEWPORT_HEIGHT,
      dataStore: "ephemeral",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        view.navigate(url),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("navigate timeout")),
            BROWSER_TIMEOUT_MS,
          );
        }),
      ]);
      if (timer) clearTimeout(timer);
      // Let late-rendering SPAs settle past the load event before we snapshot the DOM.
      if (BROWSER_SETTLE_MS > 0) await sleep(BROWSER_SETTLE_MS);
      const html = await view.evaluate("document.documentElement.outerHTML");
      return htmlToArticleText(String(html ?? ""), url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      return { ok: false, reason: msg.includes("timeout") ? "timeout" : "error" };
    } finally {
      if (timer) clearTimeout(timer);
      try {
        view.close();
      } catch {
        /* ignore */
      }
    }
  });
}
