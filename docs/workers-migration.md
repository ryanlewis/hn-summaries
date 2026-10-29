# Workers migration: design, soak and cutover

This doc covers moving hn-summaries off the `hn-summaries` exe.dev VM (Bun, headless Chromium, up to 1 GB of memory) onto a Cloudflare Worker. It records the design choices, the model cost and quality comparison, the workers.dev soak, and the cutover runbook.

Last updated 2026-10-25.

## Where it stands

- **Branch and PR:** `feat/hn-summaries`. The PR targets `main` and merges at cutover.
- **What runs where:** the VM still serves hn.rlew.io from `main`, unchanged. The Worker runs this branch at https://hn-summaries.ryan-9f5.workers.dev, deployed by hand, refreshing hourly at :07 UTC from its own cold cache.
- **Next:** Ryan's gates (see [What Ryan needs to do](#what-ryan-needs-to-do)), then the [cutover runbook](#cutover-runbook).

## Deployed resources

| What | Name / ID | Notes |
| --- | --- | --- |
| Worker | `hn-summaries`, https://hn-summaries.ryan-9f5.workers.dev | No custom domain. `PUBLIC_URL` is `https://hn.rlew.io`, so feed links already point at the canonical origin |
| KV namespace | `hn-summaries-cache`, `a2f2a05d282b42c5aca956178aa04597` | Created by wrangler on first deploy. Keys `cache` and `status` |
| Cron trigger | `7 * * * *` | Hourly |
| AI Gateway | `default` | Auto-created by the first request that named it (2026-10-25). Used for the Workers AI soak only. See the BYOK steps before any metered provider |
| Browser Rendering | binding `BROWSER` | Quick Actions `/content`, the fallback tier only |
| GitHub environment | `production` | Deployment-branch policy: `main` only. No secrets yet, so the CI deploy job skips with a notice |

`wrangler.jsonc` has no resource IDs. Later deploys reuse the KV namespace (wrangler lists it as "inherited").

## Design

### What is shared and what is per-runtime

The Bun service keeps working unchanged until cutover. The refresh cycle (`src/refresh.ts`), the fetch extraction tier (`src/extract.ts`), the routes (`src/routes.ts`), and the feed and page renderers are shared. Each runtime passes in its own pieces through `RefreshDeps`:

| Piece | Bun (VM) | Worker |
| --- | --- | --- |
| Cache | `data/cache.json` (`cache.ts`) | KV key `cache`, same JSON document (`src/worker/store.ts`) |
| DOM for Readability and comments | jsdom (`dom-jsdom.ts`) | linkedom (`dom-linkedom.ts`) |
| Browser tier | `Bun.WebView` + Chromium | Browser Rendering `/content` (`src/worker/browser.ts`) |
| Summaries | exe.dev ChatGPT proxy | AI Gateway over the AI binding (`src/worker/summarize.ts`) |
| Scheduling | `setInterval`, hourly | Cron trigger, hourly |
| Static files | `node:http` | Workers static assets (`public/`, `public/_headers`) |

The points gate, `MAX_NEW_PER_REFRESH`, the fallback retry pass, the time and size bounds, and the `/status` fields all come from the shared code, so they behave the same. `/status` on the Worker omits `uptimeSeconds` and `refreshRunning`, which have no meaning without a long-lived process, and both runtimes gain `lastDeferredByDeadline`.

### Scheduling: one cron invocation, no Workflow

A cron trigger with an interval of an hour or more gets 15 minutes of CPU and 15 minutes of wall clock, 128 MB of memory, and 10,000 subrequests on Workers Paid ([limits](https://developers.cloudflare.com/workers/platform/limits/)). A cycle fits:

- **Subrequests:** 1 best-list fetch, about 200 metadata GETs, then per new story about 13 (HEAD, GET and redirects, 10 comments, 1 model call), plus a few KV operations. At the 60-story cap that is about 1,000.
- **Wall clock:** Workers AI took 2–6 s per summary for the chosen model. At concurrency 5, 60 stories take a few minutes. The local test run of 3 stories took 8.4 s end to end.
- **CPU:** linkedom + Readability took 1–25 ms per article on the 23 test pages (jsdom took 4–117 ms). Parsing is synchronous, so only one DOM is in memory at a time.

The risk is a slow model making a cycle overrun, which would kill it before the cache is saved. So the Worker passes `deadlineAt` (`WORKER_RUN_BUDGET_MS`, 8 minutes): after it, no new story or fallback retry is started, and anything not started waits for the next cycle, like the `MAX_NEW_PER_REFRESH` overflow. That leaves 7 minutes for in-flight work (worst case 3 × 90 s model timeouts plus backoff). A Workflow or Queue would add durable steps, but the work doesn't need them: each cycle is idempotent and anything left uncached is retried an hour later.

### Extraction: linkedom + Readability, Browser Rendering as fallback

jsdom needs Node internals that workerd lacks, so the Worker uses linkedom with the same `@mozilla/readability`. On 23 real best-list articles (the 25 most recent cached stories with a URL, fetched 2026-10-25), Readability gave **identical text over both DOMs on all 23**, at 1–25 ms against jsdom's 4–117 ms. HN comment bodies convert to the same text too (`tests/extract.test.ts`).

The browser tier is Browser Rendering's `/content` Quick Action over the `BROWSER` binding (no API token). It is used only after a recoverable fetch failure (`error`, `empty`, `timeout`), as on the VM. It renders with images, media, fonts and stylesheets blocked, and the HTML goes through the same Readability path.

Limits and cost ([limits](https://developers.cloudflare.com/browser-run/limits/), [pricing](https://developers.cloudflare.com/browser-run/pricing/)): Workers Paid includes 10 browser hours a month, then $0.09 an hour. Quick Actions are billed by browser time only and limited to 30 requests per second. To stay inside the included hours, `BROWSER_DAILY_BUDGET_MS` (15 minutes a day, under 8 hours a month) caps usage. It is measured from each response's `X-Browser-Ms-Used` header, or charged the full timeout when that header is missing, and stored with the telemetry in KV. Past the budget the tier is skipped until the next UTC day. Expected use is far lower: the VM's fallback rate was 0 of 21 on-list stories on 2026-10-25, and each fallback is retried at most 3 times.

### Storage: one KV document

The cache is one JSON document of about 85 KB (79 stories), written once an hour by a single writer and read on every request. KV fits that: one `get` per request, served from the edge, a 25 MiB value limit, and well inside Workers Paid's included reads and writes. The document has exactly the same shape as the VM's `data/cache.json`, so seeding at cutover is a plain copy. D1 would need a schema and gains nothing because nothing queries individual stories. R2 has no edge cache and adds latency. KV is eventually consistent (up to about 60 s across locations), which an hourly feed doesn't notice.

The time bound (`OFFLIST_RETENTION_MS`) and size bound (`MAX_CACHE_STORIES`) are the shared `pruneStale` and `capCache`, unchanged.

### Summaries: AI Gateway over the AI binding

Every model call goes through AI Gateway with `env.AI.run(model, { messages }, { gateway: { id } })` ([binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)). Calls over the binding are pre-authenticated within the account, so the Worker needs no gateway token. A provider key, when there is one, is stored in the gateway (BYOK), so the Worker holds no key either. The prompts are the VM's (`SYSTEM_PROMPT` and `buildUserMessage` in `summarize.ts`); only the transport changes.

The provider seam is `GATEWAY_PROVIDER` + `GATEWAY_MODEL` (env vars, defaults in `src/config.ts`):

| `GATEWAY_PROVIDER` | Model id sent | Billing |
| --- | --- | --- |
| `workers-ai` (default) | `GATEWAY_MODEL` as is, e.g. `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | Workers AI neurons; no key |
| `openai` | `openai/{GATEWAY_MODEL}` | The OpenAI key stored in the gateway |
| `anthropic` | `anthropic/{GATEWAY_MODEL}` | The Anthropic key stored in the gateway |

Two points about the binding path:

- **It is chat-completions shaped**, not the Responses API the VM uses. The VM's Responses path exists because the exe.dev proxy requires it. Sending the OpenAI Responses API through the gateway would mean calling `gateway.ai.cloudflare.com/.../openai/responses` by URL, which for an authenticated gateway needs a `cf-aig-authorization` token as a Worker secret. The binding avoids that secret. Not verified: that `env.AI.run("openai/...")` and `("anthropic/...")` return a chat-completions body. `responseText()` also accepts `{ response }` and Anthropic content blocks, and the first metered call will settle it.
- **Without a stored key it bills Cloudflare credits instead.** On this path only a BYOK key with the `default` alias is consulted. If none is stored, the request falls through to Unified Billing ([credential precedence](https://developers.cloudflare.com/ai-gateway/features/unified-billing/#credential-precedence)). That is why the BYOK steps below turn on **Require provider credentials**.

Why the soak runs on Workers AI rather than importing the VM's summaries: it needs no key and no spend decision, it exercises the whole Worker pipeline (extraction, gateway, KV) rather than only the renderer, and its daily use fits in the free 10,000 neurons. The VM keeps producing its own summaries for comparison.

## Cost per option

**Token counts are measured.** The real prompts were built from 5 real stories in the VM's cache, with the Worker's extraction and today's comments, and sent to Workers AI with the usage recorded. Input averaged **2,012 tokens** (range 1,108–3,425). Output averaged **390 tokens** for the chosen model, which includes any reasoning, and 908 for gpt-oss-120b, which reasons at length. The VM's own summaries have a median of 103 words, about 140 visible tokens. Other providers' tokenizers will count differently (not verified; expect within about ±15%).

**Volume:** about 13 summaries a day at the 300-point gate (README), so about 390 a month, or 0.78 M input tokens a month. Output is 0.16 M a month at 400 tokens per summary, or 0.39 M at 1,000 for a reasoning-heavy model.

| Option | Price per M tokens (input / output) | Monthly cost | Source |
| --- | --- | --- | --- |
| **Workers AI `@cf/deepseek-ai/deepseek-v4.1-flash-1017`** (soak default) | $0.30 / $1.20 | **$0**: 97 neurons per summary on average, so about 1,270 a day, inside the free 10,000 a day. List price would be $0.42 | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Workers AI `@cf/openai/gpt-oss-120b` | $0.35 / $0.75 | $0 (about 1,640 neurons a day). List $0.57 | same |
| OpenAI `gpt-6.1-sol` (the VM's model) | $2.00 / $10.00 | $3.10–$5.50 (400–1,000 output tokens; reasoning effort not measured) | [OpenAI pricing](https://developers.openai.com/api/docs/pricing), Standard tier |
| OpenAI `gpt-6-luna` | $0.10 / $0.50 | $0.16–$0.27 | same |
| Anthropic `claude-sonnet-4-6` (the VM's alternate) | $3 / $15 | $4.70 | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Anthropic `claude-sonnet-5-5` | $2 / $10 | $3.10 | same |
| Anthropic `claude-haiku-5-5` | $0.10 / $0.50 | $0.16 | same |

Prices were read on 2026-10-25. AI Gateway's core features are free, and BYOK requests pay the provider directly ([AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)). Fixed costs are unchanged: the $5 Workers Paid plan the estate already pays covers the Worker, KV and the browser hours. A wiped cache re-summarizes the 25–30 on-list stories above the gate once, which costs about two days' worth.

## Quality comparison

The same 5 stories, with prompts built as above, went through five Workers AI models. They were compared with the summary the VM published (gpt-6.1-sol, written when each story crossed the gate, so against a younger thread). Full outputs were kept outside the repo.

| Model | Verdict |
| --- | --- |
| `deepseek-v4.1-flash-1017` | **Closest to the VM.** Same structure (3–5 article sentences, then the HN reaction as a second paragraph), the same specifics (names, numbers, dates), often a little more detail. 2–6 s. Picked as the default |
| `gpt-oss-120b` | Accurate but slow (3–29 s), and spends 260–1,480 tokens reasoning. Sometimes folds the reaction into the article paragraph |
| `glm-5.3-flash` | Good when it answers, but once spent the full 2,048-token cap reasoning and returned nothing |
| `llama-3.3-70b-instruct-fp8-fast` | Fast (2 s) but thin: generic sentences and few specifics |
| `kimi-k2.5` | Failed all 5 calls with "Internal server error" (code 8008) on 2026-10-25 |

Example (story 50197404, "Getting ready to operate GNU Taler in Germany"):

- **VM (gpt-6.1-sol):** "Taler Operations AG is being formed in Bochum to operate euro payments using GNU Taler, replacing GLS Bank as the planned issuer after its January 2026 withdrawal. The company will seek BaFin authorisation as an electronic money institution; operations cannot begin before approval, and no launch date is set. It is raising capital from investors able to commit at least €50,000…"
- **Worker (deepseek-v4.1-flash):** "Taler Operations AG is being founded in Bochum as a subsidiary of Taler Systems SA to run a GNU Taler exchange for the Euro, first in Germany and then across the euro zone. It will apply to BaFin for an electronic money institution licence before operations can begin. The move follows GLS Bank's January 2026 withdrawal from the e-money issuer role… raising capital from investors able to commit at least €50,000…"

The other four stories ("Twelve years of distributed SQLite", the Google ads policy change, LLM formal verification, and the o(n log n) multiplication fallback) showed the same pattern. The fallback story correctly began "Article unavailable —".

## Feed compatibility

- **GUIDs** are `https://news.ycombinator.com/item?id={id}` with `isPermaLink="false"`, from the shared `feed.ts`. That is the same code and the same id in both sorts. URL, `?sort`, `?count` and `?min_points` are unchanged, and `/feed.xml` still works.
- **Proven byte for byte against the live feed.** On 2026-10-25 at 01:00 UTC, a fresh copy of the VM's `data/cache.json` was loaded into the Worker's local KV (`wrangler dev`) and its output compared with the live hn.rlew.io responses:

  | Request | Result |
  | --- | --- |
  | `/feed` | identical, 30 items |
  | `/feed?sort=points` | identical, 18 items |
  | `/feed?count=200` | identical, 79 items |
  | `/feed?min_points=500&sort=points&count=15` | identical, 7 items |
  | `/` | identical except the footer's model name and the analytics `<script>` from the VM's `local.options.json` (set `EXTRA_HEAD_HTML` at cutover) |

  So once the cache is seeded from the VM, Miniflux sees the same items, GUIDs and dates and creates no duplicates. Even without seeding, GUIDs would match; only new summaries' text and `pubDate` would differ.
- `tests/routes.test.ts` pins the GUID format, sort membership, filters and the 503 warm-up over `fixtures/cache.sample.json`.

## Soak results

The soak runs the Worker from a cold cache next to the VM. `python3 scripts/soak-compare.py` (`-v` prints summaries side by side) fetches both `?sort=points&count=200` feeds and compares the on-list stories at or above the 300-point gate, then the GUIDs and summary length. Add a row after each hourly run.

| Run (UTC) | Worker run | VM above gate | Worker above gate | Same GUIDs | Only on one side | Median words (VM / Worker) |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-25 02:07 (first, cold cache) | 182 s wall, 1.3 s CPU, 17 new, 0 deferred, `lastError` null | 17 | 17 | 17 | none | 102 / 114 |

Notes from the first run:

- **The first scheduled time after deploy (01:07) did not fire.** The cron had been created at 01:00:52; the next one, 02:07, fired on time. Not verified: whether new cron triggers take a few minutes to arm.
- **The browser tier works.** It recovered "Apple Music 404 Not Found", where the fetch got no readable text. It used 18 s of browser time all day.
- **One fallback the VM didn't have.** "Show HN: Steal My Bitcoin" timed out on fetch and on the browser render, so it got a discussion-only summary. The VM read the article. The retry pass will try it again for up to 3 cycles.
- **Comparable summaries.** Same structure and specifics. The Worker's summaries run about 10% longer, still under the 120-word limit in most cases. For example, on "Dutch government had hacked into Jared Kushner's phone" both explain that the linked post is Kushner's denial, and both report the commenters doubting the headline.
- **KV caches "not found" for about a minute.** `/feed` returned 503 for up to 60 s after the first write, because the earlier reads of the missing key were cached at the edge. This only matters on a cold start.

## What Ryan needs to do

Nothing here is needed for the soak. These steps come before switching the Worker to a metered model or turning on CI deploys.

**1. Create a dedicated gateway with BYOK** (dashboard; wrangler's OAuth token has no AI Gateway scope, so this couldn't be scripted):

1. AI → AI Gateway → **Create gateway**, named `hn-summaries`.
2. In its **Settings**: turn on **Authenticated Gateway** (calls over the binding stay pre-authenticated) and **Require provider credentials** (`byok_only`). The second stops requests without a key falling through to Unified Billing. Turn log collection on or off as preferred; the prompts are public HN content.
3. **Provider Keys → Add API Key**: pick the provider (OpenAI or Anthropic) and paste a key from that provider's console, alias **`default`**. The binding path ignores any other alias. Use a key limited to this project with a monthly spend cap set at the provider.
4. Optionally set a rate limit (for example 120 requests an hour) as a backstop.

Then set the Worker's vars: `AI_GATEWAY_ID=hn-summaries`, `GATEWAY_PROVIDER=openai` (or `anthropic`), `GATEWAY_MODEL=<model>`, either in `wrangler.jsonc` `vars` or in the dashboard. Choosing the provider and model, and the spend, are Ryan's decisions. The cost table above gives the options. Staying on Workers AI costs nothing and needs none of this, though step 1 is still worth doing so the Worker doesn't share the account-wide `default` gateway.

**2. CI deploy secrets.** In the repo's `production` environment (already created, `main` only), add:

- `CLOUDFLARE_ACCOUNT_ID` = `9f588ed21d84c1b3c3d56895c75c05c7`
- `CLOUDFLARE_API_TOKEN`: an account-owned token with **Workers Scripts: Edit**, **Workers KV Storage: Edit** and **Account Settings: Read**, and no zone permissions. Attaching hn.rlew.io (runbook step 4) is done by hand, so CI never touches DNS.

Without them, the deploy job skips with a notice and CI stays green.

**3. Analytics tag (optional).** The VM injects `extraHeadHtml` from `local.options.json`. On the Worker the same HTML goes in the `EXTRA_HEAD_HTML` variable, at most 5 KB (dashboard → Worker → Settings → Variables, or `wrangler secret put EXTRA_HEAD_HTML` to keep it out of git).

## Cutover runbook

Each step has a check. Don't start the next step until the check passes. Steps marked **gated** change production and need Ryan's go-ahead on the day. Steps 1, 2 and 4 were run on 2026-10-29 (cache seeded from the VM at 19:09 UTC, all three feeds byte-identical; hn.rlew.io on the Worker from 19:10 UTC), staying on Workers AI `deepseek-v4.1-flash-1017`.

**1. Merge the PR into `main`.** CI's deploy job deploys `main` to workers.dev (or skips without secrets; then run `bunx wrangler deploy` by hand).

Check: `curl -s https://hn-summaries.ryan-9f5.workers.dev/healthz` returns 200, and `bunx wrangler deployments list --name hn-summaries` shows the new version. The VM is unaffected: it runs whatever `~/app` has checked out and never pulls on its own.

**2. Seed the Worker's cache from the VM** (copying off the VM is read-only):

```bash
ssh hn-summaries.exe.xyz 'cat ~/app/data/cache.json' > cache.json
python3 -c 'import json; c=json.load(open("cache.json")); print(c["version"], len(c["stories"]))'   # expect: 1 and ~60-80
bunx wrangler kv key put cache --path cache.json --binding CACHE --remote
```

Do it just after the VM's refresh (its `/status` shows `lastRefreshAt`) and well before the Worker's next :07 run. The Worker's next cycle then sees every VM story as cached and summarizes only what is new.

Check: compare the two feeds byte for byte; they must be identical.

```bash
for q in feed 'feed?sort=points' 'feed?count=200'; do
  cmp <(curl -s "https://hn.rlew.io/$q") <(curl -s "https://hn-summaries.ryan-9f5.workers.dev/$q") && echo "same $q"
done
```

**3. Stop the VM refreshing (gated).** This is a change on the VM. Either stop the service, which ends serving through exe.dev but leaves the Worker as the only writer, or leave it running until step 4 has propagated. Two writers produce different `generatedAt` values for new stories, but the GUIDs are the same, so readers see no duplicates either way. Recommendation: leave the VM running until step 4 is verified, then `sudo systemctl stop hn-summaries`.

**4. Attach hn.rlew.io to the Worker (gated, DNS).** The `rlew.io` zone is already on Cloudflare (`lara`/`kirk.ns.cloudflare.com`). `hn` is a CNAME to `hn-summaries.exe.xyz` resolving straight to the exe.dev edge, so it is grey (DNS only). A Workers Custom Domain needs that record gone:

1. Delete the `hn` CNAME (`cf dns records list --zone rlew.io --name-exact hn.rlew.io`, then `cf dns records delete --zone rlew.io <id> --force`, or the dashboard). A non-interactive wrangler 4.148 deploy does not take it over: it fails the domain step with code 100117 ("already has externally managed DNS records").
2. Add `"routes": [{ "pattern": "hn.rlew.io", "custom_domain": true }]` to `wrangler.jsonc` and run `bunx wrangler deploy` from a terminal, logged in as Ryan (`bunx wrangler whoami` lists `zone (read)` and `workers_routes (write)`).

Between the two, hn.rlew.io doesn't resolve for up to a minute. Readers retry on their next poll.

Check: `curl -sI https://hn.rlew.io/feed` returns 200 from Cloudflare (`server: cloudflare`), `/status` has no `uptimeSeconds` (that marks the Worker), and Miniflux's next fetch of the feed adds no duplicate entries.

**5. Watch for a day.** Look at `/status` after each hour (`lastError` null, `lastNewSummaries` non-zero now and then, `fallbacks.percent` low) and at Workers Logs for the cron runs.

### Rollback

Before step 4 there is nothing to roll back: the VM serves everything. After step 4, point `hn` back at `hn-summaries.exe.xyz` (remove the custom domain in the dashboard or delete the `routes` entry and redeploy, then restore the CNAME) and `sudo systemctl start hn-summaries` if it was stopped. The VM's cache is as it was at stop time and catches up on its first refresh. GUIDs are the same on both sides, so readers see no duplicates in either direction.

### What to delete afterwards (gated)

Once the Worker has served hn.rlew.io cleanly for a few days:

- The `hn-summaries` exe.dev VM (with its Chromium install and `~/app`).
- Bun-only code: `index.ts`, `src/server.ts`, `src/cache.ts`'s file I/O, `src/dom-jsdom.ts`, `src/extract-browser.ts`, `src/bun-webview.d.ts`, `src/options.ts`, `local.options.example.json`, the exe.dev transports in `src/summarize.ts` (keep the prompts and `callWithRetry`), `hn-summaries.service`, and the jsdom, `@types/jsdom` and `install-browser` dependencies. Then move `src/worker/*` up if wanted, and drop the `CACHE_PATH` guard in `config.ts`.
- Docs: rewrite the README's Deployment and "Running locally" sections and CLAUDE.md's Deployment section for the Worker. Update the vault note `personal/services/hn-summaries.md` and the estate plan's VM list.
- The Forgejo pull mirror on exe.dev, if it goes with the estate.

## Gotchas found along the way

- **`import.meta.url` is not a file URL in workerd.** `config.ts`'s default `CACHE_PATH` threw "Invalid URL string" at startup; it is now only computed when the URL starts with `file:`.
- **A Worker's entry module may export only handlers.** Exporting a constant made workerd refuse to start ("Incorrect type for map entry"), so the KV helpers live in `src/worker/store.ts`.
- **`quickAction()` doesn't run under plain `wrangler dev`.** It needs `--remote`. Locally the tier fails and the story is a fallback, which is fine for testing the rest.
- **The AI binding always calls the real service, even in `wrangler dev`.** Local test runs use real Workers AI neurons (a few hundred per run).
- **Named AI Gateways must exist before use.** A request naming a missing gateway gets 2001 "Please configure AI Gateway in the Cloudflare dashboard". Only `default` is created on first use.
- **HN comments lose paragraph breaks.** HN separates paragraphs with a bare `<p>`, and `htmlToText` only turns `</p>` into a break, so paragraphs run together. This happens on the VM today too, so it is kept identical here and listed as a follow-up.
