// Small shared rendering helpers used by both the RSS renderer (feed.ts) and
// the HTML landing page (page.ts). Pure string functions — no DOM.
import { ROLLOFF_WARN_BAND, type FeedSort } from "./config.js";
import type { CachedStory } from "./cache.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Attribute values use the same escaping as text. escapeHtml is a strict superset of what
// an attribute needs (it also escapes the single quote), so delegate rather than maintain a
// parallel implementation that could drift and leave an attribute-context escaping gap.
export const escapeAttr = escapeHtml;

/** Split a summary on blank lines and wrap each block in an escaped <p>. */
export function summaryHtml(summary: string): string {
  return summary
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("\n");
}

/** Registrable hostname for the article URL, www-stripped (e.g. "github.com",
 *  "bbc.co.uk", "xyz.substack.com"). Empty for self-posts / bad URLs. */
export function siteDomain(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** "{domain} · {score} points · {n} comments · by {author} · {date}" */
export function statsLine(s: CachedStory): string {
  const posted = new Date(s.time * 1000).toUTCString();
  const comments = `${s.descendants} comment${s.descendants === 1 ? "" : "s"}`;
  const domain = siteDomain(s.url);
  const prefix = domain ? `${domain} · ` : "";
  return `${prefix}${s.score} points · ${comments} · by ${s.by} · ${posted}`;
}

/** Order + cap the cached stories for a feed/landing view.
 *  - "points": the HN best-list ranking — on-list stories only, lowest rank first. An
 *    entry disappears as soon as the story leaves the best list.
 *  - "date": a rolling stream — newest summary first, keeping stories that recently fell
 *    off the best list (until they're pruned), so the view keeps moving as summaries land. */
export function selectStories(
  stories: CachedStory[],
  opts: { count: number; minPoints: number; sort: FeedSort },
): CachedStory[] {
  const pool = stories.filter((s) =>
    opts.sort === "points"
      ? s.onList !== false && s.score >= opts.minPoints
      : s.score >= opts.minPoints,
  );
  pool.sort(
    opts.sort === "points"
      ? (a, b) => a.rank - b.rank
      : (a, b) => summaryTime(b) - summaryTime(a),
  );
  return pool.slice(0, opts.count);
}

/** When the current summary was generated — i.e. when the story entered the feed. This is
 *  the date the "newest first" view sorts on and the RSS item date, so a freshly-summarized
 *  story surfaces at the top of a reader. Falls back to post time for pre-field entries. */
export function summaryTime(s: CachedStory): number {
  return s.generatedAt || s.time * 1000;
}

/** Length of the current best list, inferred from the highest on-list rank (HN serves ~200).
 *  Used to judge how close a story is to rolling off the bottom. 0 when nothing is on-list. */
export function bestListSize(stories: CachedStory[]): number {
  let max = -1;
  for (const s of stories) {
    if (s.onList !== false && s.rank > max) max = s.rank;
  }
  return max + 1;
}

export interface RankStanding {
  offList: boolean; // no longer on the HN best list (only shown in the rolling "date" view)
  nearRolloff: boolean; // on-list but within ROLLOFF_WARN_BAND of the bottom — about to drop
  label: string; // e.g. "#187 / 200 on HN best" or "dropped off the best list"
}

/** Describe a story's standing on the HN best list, for the per-item rank/roll-off line. */
export function rankStanding(s: CachedStory, listSize: number): RankStanding {
  if (s.onList === false) {
    return { offList: true, nearRolloff: false, label: "dropped off the best list" };
  }
  const within = listSize > 0 ? ` / ${listSize}` : "";
  return {
    offList: false,
    nearRolloff: listSize > 0 && s.rank >= listSize - ROLLOFF_WARN_BAND,
    label: `#${s.rank + 1}${within} on HN best`,
  };
}
