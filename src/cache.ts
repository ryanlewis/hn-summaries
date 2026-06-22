// Persistent JSON cache with an in-memory singleton.
// One process owns this, so reads come straight from memory and writes are
// atomic (write tmp -> rename).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CACHE_PATH,
  CACHE_TMP_PATH,
  CACHE_VERSION,
  OFFLIST_RETENTION_MS,
} from "./config.js";

export interface CachedStory {
  id: number;
  title: string;
  url?: string; // article URL; absent for self-posts
  score: number;
  by: string;
  time: number; // unix seconds (original post time)
  descendants: number; // comment count
  summary: string;
  isFallback: boolean; // true when the article couldn't be read
  fallbackReason?: string; // why the article was unavailable (only set when isFallback)
  fallbackAttempts?: number; // re-extraction attempts made while in fallback (retry budget)
  generatedAt: number; // Date.now() when summarized
  rank: number; // position in the best list (for ordering)
  onList?: boolean; // currently on the HN best list (only these appear in the feed)
  lastSeenAt?: number; // Date.now() of the last refresh this was on the best list
}

export interface CacheFile {
  version: typeof CACHE_VERSION;
  updatedAt: number; // Date.now() of last successful refresh
  stories: Record<string, CachedStory>; // keyed by id.toString()
}

let memory: CacheFile | null = null;

function empty(): CacheFile {
  return { version: CACHE_VERSION, updatedAt: 0, stories: {} };
}

/** Load the cache from disk on first call; thereafter return the in-memory copy. */
export async function loadCache(): Promise<CacheFile> {
  if (memory) return memory;
  try {
    const raw = await readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed && parsed.version === CACHE_VERSION && parsed.stories) {
      memory = parsed;
    } else {
      memory = empty();
    }
  } catch {
    memory = empty();
  }
  return memory;
}

/** Atomically persist the cache and refresh the in-memory copy. */
export async function saveCache(cache: CacheFile): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_TMP_PATH, JSON.stringify(cache), "utf8");
  await rename(CACHE_TMP_PATH, CACHE_PATH);
  memory = cache;
}

/**
 * Drop only stories that have been OFF the best list longer than the retention
 * window. Stories still on the list, or recently off it, are kept so a story that
 * bounces off and back isn't re-summarized.
 */
export function pruneStale(cache: CacheFile, now: number): number {
  let removed = 0;
  for (const [key, s] of Object.entries(cache.stories)) {
    if (s.onList === false && now - (s.lastSeenAt ?? 0) > OFFLIST_RETENTION_MS) {
      delete cache.stories[key];
      removed++;
    }
  }
  return removed;
}

export function getStories(cache: CacheFile): CachedStory[] {
  return Object.values(cache.stories);
}
