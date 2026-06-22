// Local, gitignored runtime options — per-deployment settings we deliberately keep OUT
// of the repo (e.g. an analytics snippet carrying a private site id). Distinct from
// config.ts on purpose: config.ts holds checked-in, compile-time tunables; this is a
// local JSON file loaded once at startup. Missing/invalid file => empty options, i.e.
// every feature here is simply off by default. See local.options.example.json for the
// shape. Override the path with OPTIONS_PATH, or any single value via its env var below.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface LocalOptions {
  /**
   * Raw HTML injected verbatim into the landing-page <head>. Operator-controlled and
   * NOT escaped — intended for analytics tags, site-verification meta, and the like.
   */
  extraHeadHtml?: string;
}

const OPTIONS_PATH =
  process.env.OPTIONS_PATH ??
  fileURLToPath(new URL("../local.options.json", import.meta.url));

function load(): LocalOptions {
  let fromFile: LocalOptions = {};
  try {
    const parsed = JSON.parse(readFileSync(OPTIONS_PATH, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fromFile = parsed as LocalOptions;
    }
  } catch {
    /* no/invalid local options file — features stay off */
  }
  // Env override, handy for container/ad-hoc runs without a file on disk.
  const envHead = process.env.EXTRA_HEAD_HTML;
  return { ...fromFile, ...(envHead ? { extraHeadHtml: envHead } : {}) };
}

/** Singleton: read once at process start, same lifecycle as the config constants. */
export const options: LocalOptions = load();
