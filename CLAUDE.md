# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Bun/TypeScript service that turns the Hacker News "best" list into an AI-summarized RSS feed plus an HTML landing page. It runs as a long-lived process: serve HTTP immediately, refresh hourly, summarize new stories once they clear a points threshold, and persist everything to a single JSON cache. Live at `https://hn.rlew.io` (`/feed` for RSS, `/` for the page).

## Commands

```bash
bun start          # run the server (bun index.ts; no build step)
bun run dev        # offline local dev: serve the fixture, no refresh (see below)
bun run typecheck  # tsc --noEmit (the only "test"; run this before committing)
```

- **Local dev without a VM:** `bun run dev` = `CACHE_PATH=fixtures/cache.sample.json REFRESH_DISABLED=1 bun index.ts`. It serves the committed fixture (`fixtures/cache.sample.json`, ~15 records hitting every render branch) and skips the boot + hourly refresh entirely — no HN fetch, no summarization, no Chrome. The point: iterate on `page.ts` / `feed.ts` / `html.ts` offline at zero cost (summarization only authenticates on an exe.dev VM, so the real pipeline can't run off-VM). `CACHE_PATH` (override the cache file; resolved against the cwd when relative) and `REFRESH_DISABLED` (skip the network pipeline, serve the cache only) both live in `config.ts`.
- Runs on **Bun** (≥1.3.12 — `Bun.WebView` needs 1.3.12+). Dev and deploy run 1.4.2, recorded in `.bun-version` for version managers/CI; Bun doesn't read it and the systemd unit execs an absolute path, so the version is documented, not enforced — see Deployment for which binary that path currently is. Bun runs the TS directly; there is no `tsx`, no build, no bundler, no test runner.
- There is no lint step. Type-checking is the gate.
- `smoke.ts` is a throwaway one-shot that runs a single real HN story through the whole pipeline and writes `/tmp/smoke-{feed.xml,page.html}` (one gateway call, ~1¢). It's gitignored; recreate it ad hoc (`bun smoke.ts`) to eyeball pipeline output without touching the cache.
- Note the `.js` extension on all relative imports (e.g. `import ... from "./config.js"`) — required by `NodeNext` module resolution even though the source is `.ts`. Bun resolves these too. Match this when adding files.

## Architecture

Entry: `index.ts` → `startServer()` (serves at once), then `runRefresh()` once, then on an hourly `setInterval`. The HTTP server and the refresh loop share state only through the in-memory cache singleton.

**Refresh pipeline** (`src/refresh.ts`, the orchestrator):
1. `fetchBestIds()` — the ranked ~200 "best" ids from HN's Firebase API.
2. `fetchBestMetadata()` — one sweep fetching current item metadata for every id on the list, at `METADATA_CONCURRENCY` (wider than `CONCURRENCY_LIMIT`; these are cheap single GETs, ~2s for the full list). Its result feeds steps 3 and 4, and is handed to `processStory` so a story clearing the gate isn't fetched twice. (`retryFallback` still does its own fetch — deliberately, since it wants comments/score fresh at the moment it pays for a re-summarize.) Ids HN won't serve are simply absent from the map — **a miss means "no information", never zero**.
3. Each cached story is marked on/off the current best list; on-list survivors get a fresh `rank` + `lastSeenAt` (rank shifts without resummarizing) **and a refreshed `score` + `descendants` from the sweep**. That refresh matters: a story is summarized as it *enters* the list, i.e. at its weakest, so without it every story keeps its entry-day score forever — which is both what `?min_points` filters on and what the feed prints. On a sweep miss the last known figures are kept. `pruneStale()` then drops only stories that have been **off** the list longer than `OFFLIST_RETENTION_MS`, so a story that briefly drops off keeps its summary and isn't re-summarized when it bounces back.
4. New ids (not already cached) are filtered by `MIN_POINTS_TO_SUMMARIZE` — a story is only summarized once it has proven itself, which cuts both feed volume and LLM spend and means the discussion is mature enough to be worth summarizing. Sub-threshold stories are left uncached and re-evaluated every cycle, so they're picked up the moment they cross. Survivors are processed with `p-limit` concurrency (`CONCURRENCY_LIMIT`), capped at `MAX_NEW_PER_REFRESH` per cycle (cost backstop against a wiped-cache re-backfill; overflow defers to the next cycle).
5. Per story (`processStory`): reuse the swept item (or fetch it), gather top comments, extract article text via `extractArticleTextTiered` (fetch → browser-render fallback, or use self-post `text`, or fall back to title+discussion), summarize, build a `CachedStory`. The `fallbackReason` is persisted so `/status` can report the fallback rate + reason breakdown.
6. **Fallback-retry pass** (`retryFallback`, gated by `FALLBACK_RETRY_ENABLED`): cached on-list fallbacks are re-extracted in place (least-tried first, bounded by `MAX_FALLBACK_RETRIES` per story and `MAX_FALLBACK_RETRIES_PER_CYCLE` per cycle) and re-summarized if extraction now succeeds — self-healing for stories the browser tier can later render or that were transiently down. Recovered count surfaces in `/status`. (The normal path never re-summarizes cached ids, so this is the only way an existing fallback flips back to a real summary.)
7. `capCache()` enforces the `MAX_CACHE_STORIES` hard ceiling after all additions — on-list stories are never evicted; while still over cap, off-list stories are dropped oldest-summary-first. Then `saveCache()` writes atomically (tmp file → rename).

A story that throws is left uncached and retried next cycle. A failed refresh leaves the cache untouched; an empty best list is treated as a transient error and skipped.

**Module map** (all under `src/`):
- `config.ts` — **every checked-in tunable lives here.** Endpoints, model, timeouts, caps, concurrency, feed defaults, cache path. Change behavior here first. (For per-deployment secrets/settings that must stay OUT of the repo, see `options.ts` instead.)
- `options.ts` — local, **gitignored** runtime options loaded once at startup from `local.options.json` (path overridable via `OPTIONS_PATH`). For per-deployment settings deliberately kept out of git — currently `extraHeadHtml`, raw HTML injected verbatim into the landing-page `<head>` (e.g. an analytics tag with a private site id). Missing file ⇒ features off. `local.options.example.json` (committed) documents the shape.
- `cache.ts` — `CachedStory`/`CacheFile` types + the in-memory singleton. Single-writer model: reads come from memory, writes are atomic. `CACHE_VERSION` bump invalidates the on-disk cache (treated as empty if mismatched).
- `hn.ts` — HN Firebase client. `fetchStory`/`fetchComment` return `null` for dead/deleted/non-story/error rather than throwing.
- `extract.ts` — fetch + `@mozilla/readability` extraction with a HEAD pre-check, content-type filtering, and a hard byte cap (streamed). `htmlToArticleText` is the shared jsdom+Readability core (reused by the browser tier). `extractArticleTextTiered` is what the pipeline calls: it tries the fetch path, then — only on a *recoverable* failure (`error`/`empty`/`timeout`, not `non-html`/`too-large`) — falls back to the browser tier. Also exports `htmlToText` (used for comments and self-posts) backed by a single reused scratch jsdom document — safe because it's fully synchronous.
- `extract-browser.ts` — the headless-browser fallback tier. Renders the page with `Bun.WebView` (Chrome/Chromium over CDP on Linux), grabs the rendered `outerHTML`, and feeds it back through `htmlToArticleText`. Runs under its own `BROWSER_CONCURRENCY` cap with a per-render timeout + settle delay; closes views in `finally` and `Bun.WebView.closeAll()` on shutdown. Minimal ambient types for it live in `src/bun-webview.d.ts` (we avoid full `@types/bun` to keep its DOM/fetch typings from colliding with the Node globals).
- `summarize.ts` — summarization client with two selectable backends (see `SUMMARY_PROVIDER` below): the exe.dev ChatGPT/Codex proxy (OpenAI Responses API, streamed; default) and the exe.dev LLM gateway (Anthropic Messages API). Two prompt shapes: normal (article + HN-reaction sentence) and fallback (title + discussion only, prefixed "Article unavailable —"). Retries with exponential backoff; skips retry on deterministic 4xx except 429.
- `feed.ts` / `page.ts` — pure renderers (RSS XML via the `feed` lib / landing HTML) from `CachedStory[]`. `page.ts` also emits the static `<head>` metadata: `description`, canonical, RSS autodiscovery (`<link rel="alternate">` for both sorts), Open Graph + Twitter `summary_large_image` cards (image = `/og.png`), and `theme-color`. `html.ts` holds the shared pure-string helpers both use: escaping plus `selectStories` (count/minPoints filtering + rank ordering), `statsLine`, and `summaryHtml`.
- `server.ts` — routes `/`, `/feed` (`?sort=date|points` default `date`, `?count=N` default 30 max 200, `?min_points=N`), `/healthz`, `/status` (refresh telemetry from `refreshState` — including `lastScoreUpdates`, the effective `minPointsToSummarize`, and the two held-back counters `lastGatedByPoints` / `lastGatedNoMetadata` kept separate so an unreachable HN isn't reported as "not popular enough"; note `lastMetadataMisses` covers permanent causes like a dead-but-listed story as well as transient errors — plus a `fallbacks` breakdown: on-list count, fallback count/percent, and a tally by `fallbackReason`), `/robots.txt` (allow-all), and static assets (favicons + `og.png`, the social-share card). `/feed` returns 503 until the first refresh populates the cache. Ordering + selection live in `html.ts` (`selectStories`): `points` filters to on-list and sorts by `rank`; `date` keeps recently-off-list stories and sorts by `summaryTime` (generation time, also the RSS item date so new summaries surface in readers).

## Summarization backends

Summaries go through one of two exe.dev proxies, selected by `SUMMARY_PROVIDER` (`config.ts`). Both auto-authenticate the VM — **no API key is sent or needed.**

- `openai-responses` (**default**) — the exe.dev ChatGPT/Codex proxy, streaming Responses API, at `OPENAI_ENDPOINT` (`https://chatgpt.int.exe.xyz/v1/responses`), model `OPENAI_MODEL` (`gpt-5.5`). Draws on the ChatGPT subscription rather than the metered LLM token allowance.
- `anthropic` — the exe.dev LLM gateway, Anthropic Messages API, at `LLM_ENDPOINT` (`https://llm.int.exe.xyz/v1/messages`), model `LLM_MODEL` (`claude-sonnet-4-6`). Metered against the token allowance.

All endpoints/models are env-overridable. See `https://exe.dev/docs.md` for proxy details.

## Deployment

Runs as the systemd unit `hn-summaries` (repo copy: `hn-summaries.service`; installed at `/etc/systemd/system/`). Port 8000, `Restart=on-failure`, logs to journald. `ExecStart` is an absolute **bun** binary path; after changing the unit, copy it to `/etc/systemd/system/` and `sudo systemctl daemon-reload`.

**Which bun the unit runs.** `ExecStart` currently points at the side-by-side install `/home/exedev/.bun-1.4.2/bin/bun` — *not* the default `/home/exedev/.bun/bin/bun`, which is still 1.3.14 and is deliberately kept as the rollback. Rolling back is a one-line edit plus `daemon-reload` + `restart`, with no download, which is why the switch was done this way rather than by upgrading in place. Note `bun upgrade` cannot target a version — it installs whatever is latest stable — so don't reach for it here. Consolidating 1.4.2 into `~/.bun` and returning `ExecStart` to the generic path is a later step; until then the unit carries a version number, and copying a stale repo copy of the unit over the installed one would silently downgrade the running service to 1.3.14.

```bash
journalctl -u hn-summaries -f          # tail logs
sudo systemctl restart hn-summaries    # after pulling changes
```

`PUBLIC_URL=https://hn.rlew.io` (set in the unit) is the canonical origin baked into feed/page links. The vanity domain is a CNAME to `hn-summaries.exe.xyz` with an exe.dev-issued cert.

**Browser tier (Chromium).** The `Bun.WebView` fallback needs a Chrome/Chromium binary on the VM. Install one rootless with `bun run install-browser` (= `bunx playwright install chromium`). At startup the app resolves a binary itself (`ensureChromePath` in `extract-browser.ts`) — honoring an explicit `BUN_CHROME_PATH`, else a system browser on `$PATH`/common locations, else the **newest** `~/.cache/ms-playwright/chromium-*` build — and logs which it picked (or warns if the tier is enabled but none is found). So the unit hardcodes **no** version-pinned path; a Playwright reinstall to a newer build is picked up automatically. Set `Environment=BUN_CHROME_PATH=…` only to force a specific binary. Disable the whole tier with `Environment=BROWSER_FALLBACK_ENABLED=false`. Other knobs (`BROWSER_CONCURRENCY`, `BROWSER_TIMEOUT_MS`, `BROWSER_SETTLE_MS`, viewport) live in `config.ts`, all env-overridable.

## Cache & data

`data/cache.json` (gitignored) is the entire persistent state — survives restarts; summaries are never regenerated for ids already cached. Deleting it forces a full re-summarize on next refresh (subject to `MAX_NEW_PER_REFRESH` per cycle, so the backfill spreads over hours).

Size is bounded two ways, both in `config.ts`: `pruneStale()` drops off-list entries past `OFFLIST_RETENTION_MS` (time bound), and `capCache()` enforces `MAX_CACHE_STORIES` (hard size bound, on-list never evicted). Steady state ≈ the on-list set (~200) plus a short off-list rolling tail. `/status` surfaces the split (`cache.{total,onList,offList,cap}`) plus `lastPruned`/`lastEvicted` so growth is observable.
