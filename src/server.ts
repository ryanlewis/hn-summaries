// Minimal HTTP server: static assets here, everything else via routes.ts.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LLM_MODEL,
  OPENAI_MODEL,
  PORT,
  SUMMARY_PROVIDER,
} from "./config.js";
import { getStories, loadCache } from "./cache.js";
import { options } from "./options.js";
import { refreshState } from "./refresh.js";
import { route } from "./routes.js";

const SUMMARY_MODEL = SUMMARY_PROVIDER === "anthropic" ? LLM_MODEL : OPENAI_MODEL;

const startedAt = Date.now();

// Static favicon assets, loaded once at startup from app/public/.
const STATIC_ASSETS: Record<string, { body: Buffer; type: string }> = (() => {
  const dir = fileURLToPath(new URL("../public/", import.meta.url));
  const files: Array<[string, string]> = [
    ["/favicon.ico", "image/x-icon"],
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon-180.png", "image/png"],
    ["/favicon-32.png", "image/png"],
    ["/og.png", "image/png"], // social-share card (Open Graph / Twitter)
  ];
  const map: Record<string, { body: Buffer; type: string }> = {};
  for (const [route, type] of files) {
    try {
      map[route] = { body: readFileSync(dir + route.slice(1)), type };
    } catch {
      /* asset missing — skip */
    }
  }
  return map;
})();

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  const asset = STATIC_ASSETS[url.pathname];
  if (asset) {
    res.writeHead(200, {
      "content-type": asset.type,
      "cache-control": "public, max-age=604800",
    });
    res.end(asset.body);
    return;
  }

  const cache = await loadCache();
  const out = route(url, {
    stories: getStories(cache),
    updatedAt: cache.updatedAt,
    state: refreshState,
    summaryModel: SUMMARY_MODEL,
    extraHeadHtml: options.extraHeadHtml,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    refreshRunning: refreshState.running,
  });
  res.writeHead(out.status, out.headers);
  res.end(out.body);
}

export function startServer(): void {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[server] handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("Internal server error");
    });
  });
  server.listen(PORT, () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  });
}
