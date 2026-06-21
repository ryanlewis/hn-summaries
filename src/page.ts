// Server-rendered HTML landing page at "/": explains how to use the feed and
// previews the latest stories. Natively dark + `color-scheme: dark` so it stays
// consistent even under browser dark-mode extensions. Grounded in HN's identity:
// orange (#ff6600) as the sole accent; the ranked-list position is the signature.
import {
  DEFAULT_FEED_COUNT,
  FEED_PATH,
  FEED_URL,
  HN_COMMENTS_URL,
  MAX_FEED_COUNT,
  REPO_URL,
} from "./config.js";
import type { CachedStory } from "./cache.js";
import {
  escapeAttr,
  escapeHtml,
  selectStories,
  siteDomain,
  summaryHtml,
} from "./html.js";

const PREVIEW_COUNT = 5;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function buildLandingPage(
  stories: CachedStory[],
  meta: { updatedAt: number; totalCount: number },
): string {
  const latest = selectStories(stories, { count: PREVIEW_COUNT, minPoints: 0 });
  const updated =
    meta.updatedAt > 0 ? shortDate(Math.floor(meta.updatedAt / 1000)) : "—";

  const body =
    meta.totalCount === 0
      ? `<p class="empty">Warming up — the first batch of summaries is generating. Check back in a minute or two.</p>`
      : latest.map(renderCard).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Hacker News Best — AI Summarized</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/favicon-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --bg: #181512;
    --surface: #211d18;
    --line: #342c24;
    --text: #efe9e1;
    --muted: #a89d90;
    --faint: #7d7368;
    --accent: #ff6600;
    --accent-soft: #ff9248;
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --display: "Space Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --body: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: var(--body); font-size: 16px; line-height: 1.62;
    padding: clamp(1.5rem, 4vw, 3.5rem) 1.15rem 5rem;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  a { color: var(--accent-soft); text-decoration: none; }
  a:hover { text-decoration: underline; text-underline-offset: 3px; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }

  .eyebrow {
    font-family: var(--mono); font-size: .72rem; font-weight: 500;
    letter-spacing: .22em; text-transform: uppercase; color: var(--accent);
    margin: 0 0 .9rem;
  }
  h1 {
    font-family: var(--display); font-weight: 700;
    font-size: clamp(2rem, 6.5vw, 3rem); line-height: 1.04;
    letter-spacing: -.02em; margin: 0 0 .7rem;
  }
  .lede { color: var(--muted); font-size: 1.05rem; margin: 0 0 2.6rem; max-width: 38em; }
  .lede a { color: var(--text); border-bottom: 1px solid var(--line); }

  /* Subscribe — the page's main job: hand over the URL */
  .sub { border-top: 1px solid var(--line); padding-top: 1.8rem; margin-bottom: 3rem; }
  .urlrow { display: flex; gap: .5rem; align-items: stretch; margin: .2rem 0 1.4rem; flex-wrap: wrap; }
  .url {
    flex: 1 1 320px; min-width: 0; background: var(--surface); border: 1px solid var(--line);
    border-left: 3px solid var(--accent); border-radius: 8px;
    font-family: var(--mono); font-size: clamp(.82rem, 2.6vw, .98rem);
    padding: .85rem 1rem; color: var(--text); display: flex; align-items: center;
    overflow-x: auto; white-space: nowrap;
  }
  .copy {
    flex: 0 0 auto; font-family: var(--mono); font-size: .82rem; font-weight: 500;
    background: var(--accent); color: #1a1206; border: 0; border-radius: 8px;
    padding: 0 1.1rem; cursor: pointer; letter-spacing: .02em;
    transition: background .15s ease;
  }
  .copy:hover { background: var(--accent-soft); }
  .params { list-style: none; margin: 0; padding: 0; }
  .params li { color: var(--muted); margin: .5rem 0; font-size: .96rem; }
  .params code {
    font-family: var(--mono); font-size: .85em; background: var(--surface);
    border: 1px solid var(--line); border-radius: 5px; padding: .12rem .42rem; color: var(--accent-soft);
  }
  .params .ex { font-family: var(--mono); font-size: .85em; }

  .sectionhead {
    display: flex; align-items: baseline; gap: .8rem; flex-wrap: wrap;
    border-top: 1px solid var(--line); padding-top: 1.8rem; margin-bottom: 1.4rem;
  }
  .sectionhead .meta { font-family: var(--mono); font-size: .74rem; color: var(--faint); letter-spacing: .04em; }

  .card {
    display: grid; grid-template-columns: 2.6rem 1fr; gap: .2rem 1rem;
    padding: 1.3rem 0; border-top: 1px solid var(--line);
  }
  .card:first-of-type { border-top: 0; }
  .rank {
    font-family: var(--mono); font-weight: 500; font-size: 1rem; color: var(--accent);
    padding-top: .15rem;
  }
  .card h3 { font-family: var(--display); font-weight: 600; font-size: 1.2rem; line-height: 1.3; margin: 0 0 .5rem; }
  .card h3 a { color: var(--text); }
  .card h3 a:hover { color: var(--accent-soft); text-decoration: none; }
  .card p { margin: .5rem 0; color: #d9d2c8; font-size: .97rem; }
  .fallback { color: var(--accent-soft) !important; font-style: italic; font-size: .9rem !important; }
  .links { font-family: var(--mono); font-size: .85rem; margin: .8rem 0 .55rem !important; }
  .links a { color: var(--accent-soft); }
  .links .sep { color: var(--faint); margin: 0 .55rem; }
  .stats { font-family: var(--mono); font-size: .76rem; color: var(--faint) !important; }
  .stats .pts { color: var(--accent); }
  .stats .src { color: var(--muted); }

  .empty { color: var(--muted); font-size: 1.05rem; }
  footer {
    margin-top: 3rem; border-top: 1px solid var(--line); padding-top: 1.4rem;
    font-family: var(--mono); font-size: .74rem; color: var(--faint); letter-spacing: .03em;
  }
  @media (max-width: 460px) {
    .card { grid-template-columns: 1fr; }
    .rank { padding-top: 0; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="wrap">
  <p class="eyebrow">An RSS feed</p>
  <h1>Hacker News Best,<br>summarized.</h1>
  <p class="lede">Every entry on the <a href="https://news.ycombinator.com/best">HN “best”</a> list, rewritten as an AI summary of the story and the discussion — each linking out to the original article and the HN comments.</p>

  <section class="sub">
    <p class="eyebrow">Subscribe</p>
    <div class="urlrow">
      <span class="url" id="feedurl">${escapeHtml(FEED_URL)}</span>
      <button class="copy" type="button" data-url="${escapeAttr(FEED_URL)}">Copy</button>
    </div>
    <ul class="params">
      <li><code>?count=N</code> — stories to include (default ${DEFAULT_FEED_COUNT}, max ${MAX_FEED_COUNT}). <a class="ex" href="${FEED_PATH}?count=10">/feed?count=10</a></li>
      <li><code>?min_points=N</code> — only stories with ≥ N points. <a class="ex" href="${FEED_PATH}?min_points=300">/feed?min_points=300</a></li>
      <li>Combine: <a class="ex" href="${FEED_PATH}?count=15&min_points=200">/feed?count=15&amp;min_points=200</a></li>
    </ul>
  </section>

  <div class="sectionhead">
    <p class="eyebrow" style="margin:0;">Latest</p>
    <span class="meta">updated ${escapeHtml(updated)} · ${meta.totalCount} cached</span>
  </div>
  ${body}

  <footer>Refreshes hourly · summaries by Claude Sonnet 4.6 · <a href="${REPO_URL}">source on GitHub</a> · content © its authors</footer>
</div>
<script>
  document.querySelector(".copy")?.addEventListener("click", async (e) => {
    const b = e.currentTarget;
    try {
      await navigator.clipboard.writeText(b.dataset.url);
      const t = b.textContent; b.textContent = "Copied";
      setTimeout(() => { b.textContent = t; }, 1500);
    } catch (_) { /* clipboard unavailable; URL is still visible */ }
  });
</script>
</body>
</html>`;
}

function renderCard(s: CachedStory): string {
  const hnUrl = HN_COMMENTS_URL(s.id);
  const articleLink = s.url ?? hnUrl;
  const rank = String(s.rank + 1).padStart(2, "0");
  const fallback = s.isFallback
    ? `<p class="fallback">Article unavailable — summary based on the HN discussion.</p>`
    : "";
  const comments = `${s.descendants} comment${s.descendants === 1 ? "" : "s"}`;
  const domain = siteDomain(s.url);
  const src = domain ? `<span class="src">${escapeHtml(domain)}</span> · ` : "";
  return `<article class="card">
  <div class="rank">${rank}</div>
  <div>
    <h3><a href="${escapeAttr(articleLink)}">${escapeHtml(s.title)}</a></h3>
    ${fallback}
    ${summaryHtml(s.summary)}
    <p class="links"><a href="${escapeAttr(articleLink)}">Original article ↗</a><span class="sep">·</span><a href="${escapeAttr(hnUrl)}">HN comments ↗</a></p>
    <p class="stats">${src}<span class="pts">${s.score}</span> points · ${comments} · ${escapeHtml(s.by)} · ${escapeHtml(shortDate(s.time))}</p>
  </div>
</article>`;
}
