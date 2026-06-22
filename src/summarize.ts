// Summarization client. Two backends (see SUMMARY_PROVIDER in config.ts):
//   - "openai-responses": exe.dev ChatGPT/Codex proxy, streaming Responses API.
//     Draws on the ChatGPT subscription, not the metered LLM token allowance.
//   - "anthropic": exe.dev LLM gateway, Anthropic Messages API (claude-sonnet-4-6).
// Both auto-authenticate the VM, so no API key is sent.
import {
  ANTHROPIC_VERSION,
  LLM_ENDPOINT,
  LLM_MAX_TOKENS,
  LLM_MODEL,
  LLM_TIMEOUT_MS,
  OPENAI_ENDPOINT,
  OPENAI_MODEL,
  RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  SUMMARY_PROVIDER,
} from "./config.js";

const SYSTEM_PROMPT =
  "You are a concise technical news summarizer for an RSS feed. " +
  "Write plain prose only: no markdown, no bullet points, no headings, no links, " +
  'and no preamble such as "This article" or "The author". ' +
  "Write as if the reader already knows this is a summary. Be factual and neutral.";

export interface SummarizeInput {
  title: string;
  url?: string;
  /** Extracted article (or self-post) text. Undefined => fallback mode. */
  articleText?: string;
  /** Why the article was unavailable (only meaningful in fallback mode). */
  fallbackReason?: string;
  /** Pre-cleaned, newline-joined top comments (or empty). */
  commentsText: string;
}

class LLMError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export async function summarize(input: SummarizeInput): Promise<string> {
  const userMessage = input.articleText
    ? buildArticlePrompt(input)
    : buildFallbackPrompt(input);
  const call =
    SUMMARY_PROVIDER === "anthropic"
      ? () => callAnthropic(userMessage)
      : () => callOpenAIResponses(userMessage);
  return callWithRetry(call);
}

function buildArticlePrompt(i: SummarizeInput): string {
  return `Story title: ${i.title}
Article URL: ${i.url ?? "(self-post)"}

ARTICLE TEXT:
"""
${i.articleText}
"""

TOP HACKER NEWS COMMENTS (plain text; may be empty):
"""
${i.commentsText || "(no comments yet)"}
"""

Write a 3-5 sentence summary of the article, then 1-2 sentences on how the Hacker News community is reacting in the comments. If there are no comments, omit the reaction. Keep the whole thing under 120 words.`;
}

function buildFallbackPrompt(i: SummarizeInput): string {
  return `Story title: ${i.title}
Note: the linked content could not be read (${i.fallbackReason ?? "unavailable"}), so base the summary on the title and the discussion only.

TOP HACKER NEWS COMMENTS (plain text; may be empty):
"""
${i.commentsText || "(no comments yet)"}
"""

In 3-5 sentences, explain what this story is about based on the title and discussion, then 1-2 sentences on how the Hacker News community is reacting. Begin your response with "Article unavailable — ". Keep the whole thing under 120 words.`;
}

async function callWithRetry(fn: () => Promise<string>): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e instanceof LLMError ? e.status : undefined;
      // Don't retry deterministic 4xx (except 429 rate limit).
      if (status && status >= 400 && status < 500 && status !== 429) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("summarize failed");
}

/** exe.dev ChatGPT/Codex proxy — OpenAI Responses API, streamed (SSE). The backend
 *  requires stream:true + store:false, an `input` list, and rejects max_output_tokens. */
async function callOpenAIResponses(userMessage: string): Promise<string> {
  const res = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      stream: true,
      store: false,
      instructions: SYSTEM_PROMPT,
      input: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new LLMError(`OpenAI HTTP ${res.status} ${detail}`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let streamErr: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt: { type?: string; delta?: string };
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      if (evt.type === "response.output_text.delta") {
        text += evt.delta ?? "";
      } else if (evt.type === "response.failed" || evt.type === "error") {
        streamErr = payload.slice(0, 200);
      }
    }
  }

  const out = text.trim();
  if (!out) {
    throw new LLMError(
      streamErr
        ? `OpenAI stream error: ${streamErr}`
        : "OpenAI returned empty content",
    );
  }
  return out;
}

/** exe.dev LLM gateway — Anthropic Messages API. */
async function callAnthropic(userMessage: string): Promise<string> {
  const res = await fetch(LLM_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: LLM_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new LLMError(`LLM HTTP ${res.status} ${detail}`, res.status);
  }

  const body = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = body.content
    ?.filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  if (!text) throw new LLMError("LLM returned empty content");
  return text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
