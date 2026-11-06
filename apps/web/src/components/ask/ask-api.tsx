"use client";

import { createContext, use } from "react";
import { z } from "zod";
import { AskEvent, RecentQuestion, SavedAnswer, type Verdict } from "@/lib/answers";
import type { QuestionId, SuggestionId } from "@/lib/ids";
import { ApproveOutcome, SuggestOutcome, type ApproveRequest, type SuggestRequest } from "@/lib/suggestions";

// What the ask panel and suggestion pages fetch. Kept apart from LabApi so the fixture pages
// can swap in canned answers without touching the rest of the lab's API.
export type AskApi = {
  // Calls onEvent for each line the route streams; rejects with a message to show.
  ask: (question: string, onEvent: (event: AskEvent) => void, signal: AbortSignal) => Promise<void>;
  answer: (id: QuestionId, signal: AbortSignal) => Promise<SavedAnswer>;
  recent: (signal: AbortSignal) => Promise<RecentQuestion[]>;
  feedback: (id: QuestionId, verdict: Verdict) => Promise<void>;
  // These reject with an Error whose message can be shown.
  suggest: (req: SuggestRequest) => Promise<SuggestOutcome>;
  approve: (id: SuggestionId, req: ApproveRequest) => Promise<ApproveOutcome>;
  dismiss: (id: SuggestionId) => Promise<void>;
};

const ErrorBody = z.object({ error: z.string() });

async function send(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function failure(json: unknown, fallback: string): Error {
  const parsed = ErrorBody.safeParse(json);
  return new Error(parsed.success ? parsed.data.error : fallback);
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function readLines(res: Response, onEvent: (event: AskEvent) => void): Promise<void> {
  if (res.body === null) throw new Error("The answer didn't arrive. Try again.");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let cut = buffer.indexOf("\n");
    while (cut >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line !== "") {
        const event = AskEvent.safeParse(JSON.parse(line));
        if (event.success) onEvent(event.data);
      }
      cut = buffer.indexOf("\n");
    }
  }
}

export const httpAskApi: AskApi = {
  ask: async (question, onEvent, signal) => {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
      signal,
    });
    if (!res.ok) throw failure(await res.json().catch(() => null), "Asking isn't working right now. Try again in a minute.");
    await readLines(res, onEvent);
  },
  answer: async (id, signal) => SavedAnswer.parse(await getJson(`/api/ask/${id}`, signal)),
  recent: async (signal) => z.array(RecentQuestion).parse(await getJson("/api/ask", signal)),
  feedback: async (id, verdict) => {
    const { status, json } = await send(`/api/ask/${id}`, { verdict });
    if (status !== 200) throw failure(json, "We couldn't save that. Try again.");
  },
  suggest: async (req) => {
    const { status, json } = await send("/api/suggestions", req);
    if (status !== 200) throw failure(json, "We couldn't draft a suggestion. Try again.");
    return SuggestOutcome.parse(json);
  },
  approve: async (id, req) => {
    const { status, json } = await send(`/api/suggestions/${id}/approve`, req);
    if (status !== 200 && status !== 409) throw failure(json, "We couldn't approve that. Try again.");
    const outcome = ApproveOutcome.safeParse(json);
    if (!outcome.success) throw failure(json, "We couldn't approve that. Try again.");
    return outcome.data;
  },
  dismiss: async (id) => {
    const { status, json } = await send(`/api/suggestions/${id}/dismiss`, {});
    if (status !== 200) throw failure(json, "We couldn't dismiss that. Try again.");
  },
};

const AskApiContext = createContext<AskApi>(httpAskApi);
export const AskApiProvider = AskApiContext.Provider;

export function useAskApi(): AskApi {
  return use(AskApiContext);
}
