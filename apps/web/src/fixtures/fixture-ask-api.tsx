"use client";

import type { ReactNode } from "react";
import { AskApiProvider, type AskApi } from "@/components/ask/ask-api";
import type { AnswerSource, AskEvent } from "@/lib/answers";
import { answerSentences, answerSources, closestSources, doneOf, protocolEdit, recentQuestions, retrievalSteps, savedAnswer, writeStep } from "./answers";
import { purification } from "./protocols";

// The ask API for fixture pages: each view's events, paced like a real question (a search of
// about half a second, then the reads in one burst, then the model's sentences), so the
// screenshots and clips show the box the way it streams.

// streaming holds after the first sentence, for a picture of the box mid-answer.
export type FixtureAnswer = "answer" | "streaming" | "cached" | "no-answer" | "limit";

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      reject(signal.reason);
    });
  });

// Each event with how long after the one before it arrives; a null event holds the stream open.
type Beat = { after: number; event: AskEvent | null };

function retrieval(question: string, sources: readonly AnswerSource[], searchMs: number): Beat[] {
  const steps = retrievalSteps(question, sources);
  return [
    { after: 60, event: { type: "step", step: steps.running } },
    { after: searchMs, event: { type: "step", step: steps.done[0] ?? steps.running } },
    ...steps.done.slice(1).map((step): Beat => ({ after: 0, event: { type: "step", step } })),
    { after: 0, event: { type: "sources", sources: [...sources] } },
  ];
}

function timeline(answer: FixtureAnswer, question: string): Beat[] {
  const sentence = (i: number, after: number): Beat[] => {
    const s = answerSentences[i];
    return s === undefined ? [] : [{ after, event: { type: "sentence", sentence: s } }];
  };
  switch (answer) {
    case "answer":
      return [
        ...retrieval(question, answerSources, 650),
        { after: 120, event: { type: "step", step: writeStep(answerSources, false) } },
        ...sentence(0, 1100),
        ...sentence(1, 450),
        ...sentence(2, 380),
        { after: 150, event: doneOf(answerSentences, "answered") },
      ];
    case "streaming":
      return [
        ...retrieval(question, answerSources, 650),
        { after: 120, event: { type: "step", step: writeStep(answerSources, false) } },
        ...sentence(0, 1100),
        { after: 0, event: null },
      ];
    case "cached":
      return [
        ...retrieval(question, answerSources, 420),
        { after: 40, event: { type: "step", step: writeStep(answerSources, true) } },
        ...answerSentences.map((s): Beat => ({ after: 30, event: { type: "sentence", sentence: s } })),
        { after: 30, event: doneOf(answerSentences, "answered", true) },
      ];
    case "no-answer":
      return [
        ...retrieval(question, closestSources, 600),
        { after: 120, event: { type: "step", step: writeStep(closestSources, false) } },
        { after: 1300, event: doneOf([], "not_found") },
      ];
    case "limit":
      return [...retrieval(question, closestSources, 600), { after: 90, event: { type: "limit", budget: { capUsd: 25, spentUsd: 25.04, resetsAt: "2026-12-01T00:00:00Z" } } }];
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
}

export function FixtureAskApi({ answer, children }: { answer: FixtureAnswer; children: ReactNode }) {
  const api: AskApi = {
    ask: async (question, onEvent, signal) => {
      for (const beat of timeline(answer, question)) {
        await wait(beat.after, signal);
        if (beat.event === null) await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
        else onEvent(beat.event);
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
