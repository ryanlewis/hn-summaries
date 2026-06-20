// Hacker News Firebase API client.
import { HN_BEST_URL, HN_ITEM_URL } from "./config.js";

export interface HNStory {
  id: number;
  type?: string;
  title?: string;
  url?: string; // absent on Ask/Show HN self-posts
  text?: string; // self-post body (HTML)
  score?: number;
  by?: string;
  time?: number; // unix seconds
  descendants?: number; // comment count
  kids?: number[]; // top-level comment ids
  dead?: boolean;
  deleted?: boolean;
}

export interface HNComment {
  id: number;
  type?: string;
  text?: string; // HTML-encoded
  by?: string;
  dead?: boolean;
  deleted?: boolean;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** Returns the ranked list of "best" story ids (~200). */
export async function fetchBestIds(): Promise<number[]> {
  const ids = await fetchJson<number[] | null>(HN_BEST_URL, 10_000);
  return Array.isArray(ids) ? ids : [];
}

/** Fetch a story; returns null for dead/deleted/non-story/errors. */
export async function fetchStory(id: number): Promise<HNStory | null> {
  try {
    const item = await fetchJson<HNStory | null>(HN_ITEM_URL(id), 10_000);
    if (!item || item.dead || item.deleted) return null;
    if (item.type && item.type !== "story") return null;
    if (!item.title) return null;
    return item;
  } catch {
    return null;
  }
}

/** Fetch a single comment; returns null for dead/deleted/errors. */
export async function fetchComment(id: number): Promise<HNComment | null> {
  try {
    const c = await fetchJson<HNComment | null>(HN_ITEM_URL(id), 8_000);
    if (!c || c.dead || c.deleted || !c.text) return null;
    return c;
  } catch {
    return null;
  }
}
