import type { JsonModel, JsonReply, JsonRequest } from "../json-model";

// A model that answers from a function and records every request, streaming its JSON a few
// characters at a time the way the real one arrives.
export function fakeJsonModel(answer: (request: JsonRequest) => unknown): JsonModel & { calls: JsonRequest[] } {
  const calls: JsonRequest[] = [];
  return {
    calls,
    async stream(request, onText): Promise<JsonReply> {
      calls.push(request);
      const value = answer(request);
      const text = value === null ? null : typeof value === "string" ? value : JSON.stringify(value);
      if (text !== null) for (let i = 0; i < text.length; i += 7) onText(text.slice(i, i + 7));
      return {
        text,
        stopReason: text === null ? "refusal" : "end_turn",
        usage: { inputTokens: 3000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: request.model,
      };
    },
  };
}
