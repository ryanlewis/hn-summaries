// The Worker's KV layout. A separate module because a Worker's entry may export only
// handlers.
import type { CacheFile } from "../cache.js";
import { CACHE_VERSION } from "../config.js";
import type { RefreshState } from "../refresh.js";
import type { BrowserBudget } from "./browser.js";

// KV keys. "cache" holds the same document as the VM's data/cache.json, so seeding at
// cutover is a straight copy; "status" holds the last cycle's telemetry for /status.
export const CACHE_KEY = "cache";
export const STATUS_KEY = "status";

export interface StoredStatus {
  state: RefreshState;
  browser: BrowserBudget;
}

export async function loadCacheFile(kv: KVNamespace): Promise<CacheFile> {
  const c = await kv.get<CacheFile>(CACHE_KEY, "json");
  // A version mismatch reads as empty, as cache.ts does on the VM.
  if (c && c.version === CACHE_VERSION && c.stories) return c;
  return { version: CACHE_VERSION, updatedAt: 0, stories: {} };
}

export async function loadStatus(kv: KVNamespace): Promise<StoredStatus | null> {
  return kv.get<StoredStatus>(STATUS_KEY, "json");
}

