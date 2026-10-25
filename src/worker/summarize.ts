// Summarization through Cloudflare AI Gateway, over the AI binding. Same prompts as the
// VM (summarize.ts); only the transport differs. The provider seam is GATEWAY_PROVIDER:
// Workers AI models run as-is, third-party models are addressed "{provider}/{model}" and
// use the key stored in the gateway (BYOK). The binding is pre-authenticated, so no
// token or key is sent from here.
import {
  AI_GATEWAY_ID,
  GATEWAY_MODEL,
  GATEWAY_PROVIDER,
  WORKERS_AI_MAX_TOKENS,
  type GatewayProvider,
} from "../config.js";
import {
  LLMError,
  SYSTEM_PROMPT,
  buildUserMessage,
  callWithRetry,
  type SummarizeInput,
} from "../summarize.js";

// The one AI binding method used here (a stub in tests).
export interface GatewayRunner {
  run(model: string, inputs: unknown, options: { gateway: GatewayOptions }): Promise<unknown>;
}

export function gatewayModelId(provider: GatewayProvider, model: string): string {
  return provider === "workers-ai" ? model : `${provider}/${model}`;
}

/**
 * Pull the text out of a model response. Workers AI returns either `{ response }` or an
 * OpenAI-style chat completion depending on the model; third-party models through the
 * gateway return their chat-completion shape; Anthropic-style content blocks are handled
 * too in case the gateway passes them through.
 */
export function responseText(out: unknown): string {
  if (typeof out === "string") return out.trim();
  const o = out as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    content?: Array<{ type?: string; text?: string }>;
  } | null;
  if (typeof o?.response === "string") return o.response.trim();
  const choice = o?.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice.trim();
  if (Array.isArray(o?.content)) {
    return o.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
  }
  return "";
}

export function gatewaySummarizer(
  ai: GatewayRunner,
  provider: GatewayProvider = GATEWAY_PROVIDER,
  model: string = GATEWAY_MODEL,
): (input: SummarizeInput) => Promise<string> {
  const id = gatewayModelId(provider, model);
  return (input) =>
    callWithRetry(async () => {
      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(input) },
      ];
      // Workers AI needs an explicit cap (some models default to a few hundred tokens).
      // Third-party models keep their provider default, as on the VM's Responses path.
      const inputs =
        provider === "workers-ai"
          ? { messages, max_tokens: WORKERS_AI_MAX_TOKENS }
          : { messages };
      const out = await ai.run(id, inputs, {
        gateway: { id: AI_GATEWAY_ID, skipCache: true },
      });
      const text = responseText(out);
      if (!text) throw new LLMError(`${id} returned empty content`);
      return text;
    });
}
