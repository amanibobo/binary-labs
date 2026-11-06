import Anthropic from "@anthropic-ai/sdk";

// The one interface the web app's model calls go through (the worker has its own, in
// bl_worker/models.py), so a model can be swapped as prices change and tests can answer
// from a recording. Every call returns strict JSON (structured outputs), which the caller
// parses again at its boundary.

export const ANSWER_MODEL = "claude-sonnet-5-5";

// Dollars per million tokens, matching the worker's table. Cache writes cost 1.25x input and
// cache reads 0.1x; the ledger needs a running figure, not an invoice.
const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  // What the refusal fallback may hand a declined request to.
  "claude-opus-5-5": { input: 4, output: 20 },
};

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export function costUsd(model: string, u: Usage): number {
  const price = PRICES[model];
  if (price === undefined) return 0;
  const perIn = price.input / 1_000_000;
  const dollars = u.inputTokens * perIn + u.cacheWriteTokens * perIn * 1.25 + u.cacheReadTokens * perIn * 0.1 + (u.outputTokens * price.output) / 1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

export type JsonRequest = {
  model: string;
  // The stable prefix: instructions first. The last block is cached between calls.
  system: readonly string[];
  user: string;
  schema: Record<string, unknown>;
  effort: "low" | "medium" | "high";
  maxTokens: number;
};

// text is the JSON the model wrote, or null when it declined or ran out of room.
export type JsonReply = { text: string | null; stopReason: string; usage: Usage; model: string };

export type JsonModel = {
  // onText gets the reply's text as it arrives.
  stream(request: JsonRequest, onText: (delta: string) => void, signal?: AbortSignal): Promise<JsonReply>;
};

// The provider couldn't be reached or turned the request down itself.
export class ModelUnavailable extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ModelUnavailable";
    this.retryable = retryable;
  }
}

export function anthropicJsonModel(apiKey: string): JsonModel {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  return {
    async stream(request, onText, signal) {
      const system = request.system.map((text, i) => ({
        type: "text" as const,
        text,
        ...(i === request.system.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
      }));
      try {
        // Sonnet 5.5 can decline a request its safety classifiers flag; the server-side
        // fallback lets another model answer it inside the same call, as the worker's Tier 3 does.
        const stream = client.beta.messages.stream(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system,
            messages: [{ role: "user", content: request.user }],
            output_config: { effort: request.effort, format: { type: "json_schema", schema: request.schema } },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
          },
          { signal },
        );
        stream.on("text", (delta) => onText(delta));
        const message = await stream.finalMessage();
        const usage: Usage = {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        };
        const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        const stopReason = message.stop_reason ?? "unknown";
        return { text: stopReason === "end_turn" && text !== "" ? text : null, stopReason, usage, model: message.model };
      } catch (error) {
        if (error instanceof Anthropic.APIConnectionError) throw new ModelUnavailable(error.message, true);
        if (error instanceof Anthropic.APIError) {
          const status = error.status ?? 0;
          throw new ModelUnavailable(error.message, status === 429 || status >= 500);
        }
        throw error;
      }
    },
  };
}
