// Small shared rendering helpers used by both the RSS renderer (feed.ts) and
// the HTML landing page (page.ts). Pure string functions — no DOM.
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

/** Apply min-points filter, order by best-list rank, and cap to count. */
export function selectStories(
  stories: CachedStory[],
  opts: { count: number; minPoints: number },
): CachedStory[] {
  return stories
    .filter((s) => s.onList !== false && s.score >= opts.minPoints)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, opts.count);
}
