// Tiered fallback extraction via a real browser (Bun.WebView). Renders the page so
// JS-built content and soft anti-bot pages produce a populated DOM, then hands the
// rendered HTML to the shared Readability path in extract.ts. Heavy compared to fetch,
// so it runs under its own concurrency cap, separate from the main refresh workers, and
// is only reached for fetch-path failures the renderer can plausibly recover.
//
// On Linux, Bun.WebView drives an installed Chrome/Chromium over CDP; the binary is
// found via $BUN_CHROME_PATH / $PATH / system locations / the Playwright cache.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import pLimit from "p-limit";
import {
  BROWSER_CONCURRENCY,
  BROWSER_FALLBACK_ENABLED,
  BROWSER_SETTLE_MS,
  BROWSER_TIMEOUT_MS,
  BROWSER_VIEWPORT_HEIGHT,
  BROWSER_VIEWPORT_WIDTH,
} from "./config.js";
import { htmlToArticleText, type ExtractionResult } from "./extract.js";

// Resolve a Chrome/Chromium binary without pinning a version. Order:
//   1. an explicit, existing $BUN_CHROME_PATH (operator override wins);
//   2. a system browser on $PATH or in common locations;
//   3. the newest Playwright-cached Chromium (chromium-NNNN/chrome-linux64/chrome).
// Acquisition is `bun run install-browser` (bunx playwright install chromium); this
// just finds whatever version that left behind, so a reinstall to a newer build
// doesn't require touching the systemd unit. Returns null if nothing is installed.
function findChromeBinary(): string | null {
  const env = process.env.BUN_CHROME_PATH;
  if (env && existsSync(env)) return env;

  const names = [
    "chromium",
    "chromium-browser",
    "google-chrome-stable",
    "google-chrome",
    "chrome",
  ];
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const dirs = [...pathDirs, "/usr/bin", "/usr/local/bin", "/snap/bin"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Playwright cache: ~/.cache/ms-playwright/chromium-NNNN/chrome-linux64/chrome.
  // Pick the highest build number so a fresh install supersedes an older one.
  const cache = join(homedir(), ".cache", "ms-playwright");
  try {
    const builds = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .map((d) => ({ dir: d, n: Number(d.slice("chromium-".length)) }))
      .sort((a, b) => b.n - a.n);
    for (const { dir } of builds) {
      const candidate = join(cache, dir, "chrome-linux64", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* no playwright cache */
  }
  return null;
}

// Resolve once at startup, log the outcome, and seed $BUN_CHROME_PATH so Bun.WebView's
// own discovery uses the same binary. Warns (rather than throws) if the tier is enabled
// but no browser exists — the pipeline still works, it just can't use this fallback.
let chromeResolved = false;
export function ensureChromePath(): void {
  if (chromeResolved) return;
  chromeResolved = true;
  const bin = findChromeBinary();
  if (bin) {
    process.env.BUN_CHROME_PATH = bin;
    console.log(`[extract-browser] using Chrome/Chromium: ${bin}`);
  } else if (BROWSER_FALLBACK_ENABLED) {
    console.warn(
      "[extract-browser] no Chrome/Chromium found — browser fallback tier disabled. " +
        "Install one with `bun run install-browser`.",
    );
  }
}

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
    ensureChromePath();
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
