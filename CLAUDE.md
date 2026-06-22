# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Bun/TypeScript service that turns the Hacker News "best" list into an AI-summarized RSS feed plus an HTML landing page. It runs as a long-lived process: serve HTTP immediately, refresh hourly, summarize only newly-arrived stories, and persist everything to a single JSON cache. Live at `https://hn.rlew.io` (`/feed` for RSS, `/` for the page).

## Commands

```bash
bun start          # run the server (bun index.ts; no build step)
bun run typecheck  # tsc --noEmit (the only "test"; run this before committing)
```

- Runs on **Bun** (≥1.3.12, pinned to 1.3.14 — needed for `Bun.WebView`). Bun runs the TS directly; there is no `tsx`, no build, no bundler, no test runner.
- There is no lint step. Type-checking is the gate.
- `smoke.ts` is a throwaway one-shot that runs a single real HN story through the whole pipeline and writes `/tmp/smoke-{feed.xml,page.html}` (one gateway call, ~1¢). It's gitignored; recreate it ad hoc (`bun smoke.ts`) to eyeball pipeline output without touching the cache.
- Note the `.js` extension on all relative imports (e.g. `import ... from "./config.js"`) — required by `NodeNext` module resolution even though the source is `.ts`. Bun resolves these too. Match this when adding files.

## Architecture

Entry: `index.ts` → `startServer()` (serves at once), then `runRefresh()` once, then on an hourly `setInterval`. The HTTP server and the refresh loop share state only through the in-memory cache singleton.

**Refresh pipeline** (`src/refresh.ts`, the orchestrator):
1. `fetchBestIds()` — the ranked ~200 "best" ids from HN's Firebase API.
2. `pruneCache()` drops cached stories no longer on the list; ranks are updated on survivors (rank shifts without resummarizing).
3. New ids (not already cached) are processed with `p-limit` concurrency (`CONCURRENCY_LIMIT`), capped at `MAX_NEW_PER_REFRESH` per cycle (cost backstop against a wiped-cache re-backfill; overflow defers to the next cycle).
4. Per story (`processStory`): fetch item + top comments, extract article text via `extractArticleTextTiered` (fetch → browser-render fallback, or use self-post `text`, or fall back to title+discussion), summarize, build a `CachedStory`. The `fallbackReason` is persisted so `/status` can report the fallback rate + reason breakdown.
5. `saveCache()` writes atomically (tmp file → rename).

A story that throws is left uncached and retried next cycle. A failed refresh leaves the cache untouched; an empty best list is treated as a transient error and skipped.

**Module map** (all under `src/`):
- `config.ts` — **every checked-in tunable lives here.** Endpoints, model, timeouts, caps, concurrency, feed defaults, cache path. Change behavior here first. (For per-deployment secrets/settings that must stay OUT of the repo, see `options.ts` instead.)
- `options.ts` — local, **gitignored** runtime options loaded once at startup from `local.options.json` (path overridable via `OPTIONS_PATH`). For per-deployment settings deliberately kept out of git — currently `extraHeadHtml`, raw HTML injected verbatim into the landing-page `<head>` (e.g. an analytics tag with a private site id). Missing file ⇒ features off. `local.options.example.json` (committed) documents the shape.
- `cache.ts` — `CachedStory`/`CacheFile` types + the in-memory singleton. Single-writer model: reads come from memory, writes are atomic. `CACHE_VERSION` bump invalidates the on-disk cache (treated as empty if mismatched).
- `hn.ts` — HN Firebase client. `fetchStory`/`fetchComment` return `null` for dead/deleted/non-story/error rather than throwing.
- `extract.ts` — fetch + `@mozilla/readability` extraction with a HEAD pre-check, content-type filtering, and a hard byte cap (streamed). `htmlToArticleText` is the shared jsdom+Readability core (reused by the browser tier). `extractArticleTextTiered` is what the pipeline calls: it tries the fetch path, then — only on a *recoverable* failure (`error`/`empty`/`timeout`, not `non-html`/`too-large`) — falls back to the browser tier. Also exports `htmlToText` (used for comments and self-posts) backed by a single reused scratch jsdom document — safe because it's fully synchronous.
- `extract-browser.ts` — the headless-browser fallback tier. Renders the page with `Bun.WebView` (Chrome/Chromium over CDP on Linux), grabs the rendered `outerHTML`, and feeds it back through `htmlToArticleText`. Runs under its own `BROWSER_CONCURRENCY` cap with a per-render timeout + settle delay; closes views in `finally` and `Bun.WebView.closeAll()` on shutdown. Minimal ambient types for it live in `src/bun-webview.d.ts` (we avoid full `@types/bun` to keep its DOM/fetch typings from colliding with the Node globals).
- `summarize.ts` — exe.dev LLM gateway client (Anthropic Messages-compatible). Two prompt shapes: normal (article + HN-reaction sentence) and fallback (title + discussion only, prefixed "Article unavailable —"). Retries with exponential backoff; skips retry on deterministic 4xx except 429.
- `feed.ts` / `page.ts` — pure renderers (RSS XML via the `feed` lib / landing HTML) from `CachedStory[]`. `html.ts` holds the shared pure-string helpers both use: escaping plus `selectStories` (count/minPoints filtering + rank ordering), `statsLine`, and `summaryHtml`.
- `server.ts` — routes `/`, `/feed` (`?count=N` default 30 max 200, `?min_points=N`), `/healthz`, `/status` (refresh telemetry from `refreshState` plus a `fallbacks` breakdown — on-list count, fallback count/percent, and a tally by `fallbackReason`), and static favicons. `/feed` returns 503 until the first refresh populates the cache.

## LLM gateway

Summaries go through the exe.dev LLM gateway at `http://169.254.169.254/gateway/llm/anthropic/v1/messages` (`LLM_ENDPOINT`). The VM is auto-authenticated by the gateway — **no API key is sent or needed.** Model is `claude-sonnet-4-6` (`LLM_MODEL`). Both are env-overridable. See `https://exe.dev/docs.md` for gateway details.

## Deployment

Runs as the systemd unit `hn-summaries` (repo copy: `hn-summaries.service`; installed at `/etc/systemd/system/`). Port 8000, `Restart=on-failure`, logs to journald. `ExecStart` is the absolute mise-managed **bun** binary (`…/installs/bun/1.3.14/bin/bun index.ts`); after changing the unit, copy it to `/etc/systemd/system/` and `sudo systemctl daemon-reload`.

```bash
journalctl -u hn-summaries -f          # tail logs
sudo systemctl restart hn-summaries    # after pulling changes
```

`PUBLIC_URL=https://hn.rlew.io` (set in the unit) is the canonical origin baked into feed/page links. The vanity domain is a CNAME to `hn-summaries.exe.xyz` with an exe.dev-issued cert.

**Browser tier (Chromium).** The `Bun.WebView` fallback needs a Chrome/Chromium binary on the VM. The unit sets `Environment=BUN_CHROME_PATH=/usr/bin/chromium`; install Chromium there (or adjust the path / put it on `$PATH`). Disable the whole tier with `Environment=BROWSER_FALLBACK_ENABLED=false`. Other knobs (`BROWSER_CONCURRENCY`, `BROWSER_TIMEOUT_MS`, `BROWSER_SETTLE_MS`, viewport) live in `config.ts`, all env-overridable.

## Cache & data

`data/cache.json` (gitignored) is the entire persistent state — survives restarts; summaries are never regenerated for ids already cached. Deleting it forces a full re-summarize on next refresh (subject to `MAX_NEW_PER_REFRESH` per cycle, so the backfill spreads over hours).
