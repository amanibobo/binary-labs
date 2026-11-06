"use client";

import type { ReactNode } from "react";
import { AskApiProvider, type AskApi } from "@/components/ask/ask-api";
import type { AskEvent } from "@/lib/answers";
import { answerEvents, closestSources, doneOf, protocolEdit, recentQuestions, savedAnswer } from "./answers";
import { purification } from "./protocols";

// The ask API for fixture pages: each view's events, streamed with small delays.

export type FixtureAnswer = "answer" | "no-answer" | "limit";

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      reject(signal.reason);
    });
  });

function eventsFor(answer: FixtureAnswer): AskEvent[] {
  switch (answer) {
    case "answer":
      return [...answerEvents, doneOf(answerEvents, "answered")];
    case "no-answer":
      return [{ type: "sources", sources: closestSources }, doneOf([], "not_found")];
    case "limit":
      return [{ type: "sources", sources: closestSources }, { type: "limit", budget: { capUsd: 25, spentUsd: 25.04, resetsAt: "2026-12-01T00:00:00Z" } }];
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
}

export function FixtureAskApi({ answer, children }: { answer: FixtureAnswer; children: ReactNode }) {
  const api: AskApi = {
    ask: async (_question, onEvent, signal) => {
      for (const event of eventsFor(answer)) {
        await wait(event.type === "sources" ? 150 : 220, signal);
        onEvent(event);
      }
    },
    answer: async () => savedAnswer,
    recent: async () => recentQuestions,
    feedback: async () => undefined,
    suggest: async () => ({ kind: "created", id: protocolEdit.id }),
    approve: async () => ({ kind: "approved", protocolId: purification.protocolId, version: purification.version + 1, applied: 1 }),
    dismiss: async () => undefined,
  };
  return <AskApiProvider value={api}>{children}</AskApiProvider>;
}
