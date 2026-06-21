# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node/TypeScript service that turns the Hacker News "best" list into an AI-summarized RSS feed plus an HTML landing page. It runs as a long-lived process: serve HTTP immediately, refresh hourly, summarize only newly-arrived stories, and persist everything to a single JSON cache. Live at `https://hn.rlew.io` (`/feed` for RSS, `/` for the page).

## Commands

```bash
npm start          # run the server via tsx (no build step) — index.ts
npm run typecheck  # tsc --noEmit (the only "test"; run this before committing)
```

- No build, no bundler, no test runner. `tsx` runs the TS directly.
- There is no lint step. Type-checking is the gate.
- `smoke.ts` is a throwaway one-shot that runs a single real HN story through the whole pipeline and writes `/tmp/smoke-{feed.xml,page.html}` (one gateway call, ~1¢). It's gitignored; recreate it ad hoc to eyeball pipeline output without touching the cache.
- Note the `.js` extension on all relative imports (e.g. `import ... from "./config.js"`) — required by `NodeNext` module resolution even though the source is `.ts`. Match this when adding files.

## Architecture

Entry: `index.ts` → `startServer()` (serves at once), then `runRefresh()` once, then on an hourly `setInterval`. The HTTP server and the refresh loop share state only through the in-memory cache singleton.

**Refresh pipeline** (`src/refresh.ts`, the orchestrator):
1. `fetchBestIds()` — the ranked ~200 "best" ids from HN's Firebase API.
2. `pruneCache()` drops cached stories no longer on the list; ranks are updated on survivors (rank shifts without resummarizing).
3. New ids (not already cached) are processed with `p-limit` concurrency (`CONCURRENCY_LIMIT`), capped at `MAX_NEW_PER_REFRESH` per cycle (cost backstop against a wiped-cache re-backfill; overflow defers to the next cycle).
4. Per story (`processStory`): fetch item + top comments, extract article text (or use self-post `text`, or fall back), summarize, build a `CachedStory`.
5. `saveCache()` writes atomically (tmp file → rename).

A story that throws is left uncached and retried next cycle. A failed refresh leaves the cache untouched; an empty best list is treated as a transient error and skipped.

**Module map** (all under `src/`):
- `config.ts` — **every tunable lives here.** Endpoints, model, timeouts, caps, concurrency, feed defaults, cache path. Change behavior here first.
- `cache.ts` — `CachedStory`/`CacheFile` types + the in-memory singleton. Single-writer model: reads come from memory, writes are atomic. `CACHE_VERSION` bump invalidates the on-disk cache (treated as empty if mismatched).
- `hn.ts` — HN Firebase client. `fetchStory`/`fetchComment` return `null` for dead/deleted/non-story/error rather than throwing.
- `extract.ts` — fetch + `@mozilla/readability` extraction with a HEAD pre-check, content-type filtering, and a hard byte cap (streamed). Also exports `htmlToText` (used for comments and self-posts) backed by a single reused scratch jsdom document — safe because it's fully synchronous.
- `summarize.ts` — exe.dev LLM gateway client (Anthropic Messages-compatible). Two prompt shapes: normal (article + HN-reaction sentence) and fallback (title + discussion only, prefixed "Article unavailable —"). Retries with exponential backoff; skips retry on deterministic 4xx except 429.
- `feed.ts` / `page.ts` — pure renderers (RSS XML via the `feed` lib / landing HTML) from `CachedStory[]`. `html.ts` holds the shared pure-string helpers both use: escaping plus `selectStories` (count/minPoints filtering + rank ordering), `statsLine`, and `summaryHtml`.
- `server.ts` — routes `/`, `/feed` (`?count=N` default 30 max 200, `?min_points=N`), `/healthz`, `/status` (refresh telemetry from `refreshState`), and static favicons. `/feed` returns 503 until the first refresh populates the cache.

## LLM gateway

Summaries go through the exe.dev LLM gateway at `http://169.254.169.254/gateway/llm/anthropic/v1/messages` (`LLM_ENDPOINT`). The VM is auto-authenticated by the gateway — **no API key is sent or needed.** Model is `claude-sonnet-4-6` (`LLM_MODEL`). Both are env-overridable. See `https://exe.dev/docs.md` for gateway details.

## Deployment

Runs as the systemd unit `hn-summaries` (repo copy: `hn-summaries.service`; installed at `/etc/systemd/system/`). Port 8000, `Restart=on-failure`, logs to journald.

```bash
journalctl -u hn-summaries -f          # tail logs
sudo systemctl restart hn-summaries    # after pulling changes
```

`PUBLIC_URL=https://hn.rlew.io` (set in the unit) is the canonical origin baked into feed/page links. The vanity domain is a CNAME to `hn-summaries.exe.xyz` with an exe.dev-issued cert.

## Cache & data

`data/cache.json` (gitignored) is the entire persistent state — survives restarts; summaries are never regenerated for ids already cached. Deleting it forces a full re-summarize on next refresh (subject to `MAX_NEW_PER_REFRESH` per cycle, so the backfill spreads over hours).
