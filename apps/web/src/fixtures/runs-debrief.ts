import type { DebriefApi } from "@/components/runs/api/debrief";
import { answerText, DEBRIEF_QUESTIONS, type AnswerWords, type Debrief, type DebriefAnswer, type DebriefQuestion } from "@/lib/debrief";
import { DebriefId, LocationId, UserId, type RunId } from "@/lib/ids";
import { members } from "./data";
import spoken from "./debrief-answers.json";
import type { FixtureRunStore } from "./runs";

// Slice D's fixture twin: its methods over the page's own copy of the runs. A recording
// "transcribes" in TRANSCRIBE_MS and comes back as the words in debrief-answers.json, the
// ones scripts/debrief-timing.mjs has the Mac's `say` speak into Chrome's fake microphone.

export const SPOKEN: Readonly<Record<DebriefQuestion, string>> = { 1: spoken[1], 2: spoken[2], 3: spoken[3], 4: spoken[4], 5: spoken[5], 6: spoken[6] };
export const TRANSCRIBE_MS = 1500;

const priyaUser = UserId.parse(members[1]?.userId);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const debriefId = (n: number) => DebriefId.parse(`5e1d0c2a-6b1f-4a7e-8d3c-0d0b2f1e${String(n).padStart(4, "0")}`);
export const fixtureAudio = (question: DebriefQuestion) => LocationId.parse(`6a2b1c3d-7e4f-4a5b-9c6d-0e1f2a3b${String(question).padStart(4, "0")}`);

// Debriefs a fixture page starts with, by run; set before the page's API is made.
const seeds = new Map<RunId, Debrief>();
export function seedFixtureDebrief(debrief: Debrief): void {
  seeds.set(debrief.runId, structuredClone(debrief));
}

export const heardAnswer = (question: DebriefQuestion, correction: string | null = null): DebriefAnswer => ({
  question,
  words: { kind: "recording", audio: fixtureAudio(question), heard: { kind: "heard", transcript: SPOKEN[question] }, correction },
  fixWorked: null,
});

export function fixtureDebrief(runId: RunId, answers: DebriefAnswer[], state: Debrief["state"] = "open"): Debrief {
  return {
    id: debriefId(1),
    runId,
    state,
    startedBy: priyaUser,
    startedAt: "2026-10-15T17:05:00Z",
    approvedAt: state === "approved" ? "2026-10-15T17:09:00Z" : null,
    answers,
  };
}

export const fixtureDebriefApi = (store: FixtureRunStore): DebriefApi => {
  const byRun = new Map<RunId, Debrief>([...seeds].map(([run, d]) => [run, structuredClone(d)]));
  let made = 1;
  const find = (id: DebriefId): Debrief => {
    const found = [...byRun.values()].find((d) => d.id === id);
    if (found === undefined) throw new Error("Those answers don't exist any more.");
    if (found.state !== "open") throw new Error("These answers were already saved or thrown away. Open the run to see them.");
    return found;
  };
  const put = (d: Debrief, question: DebriefQuestion, change: (a: DebriefAnswer) => DebriefAnswer | null): Debrief => {
    const before = d.answers.find((a) => a.question === question) ?? { question, words: { kind: "none" }, fixWorked: null };
    const after = change(before);
    const keep = after !== null && (after.words.kind !== "none" || after.fixWorked !== null);
    const answers = [...d.answers.filter((a) => a.question !== question), ...(keep ? [after] : [])].sort((x, y) => x.question - y.question);
    const next = { ...d, answers };
    byRun.set(d.runId, next);
    return structuredClone(next);
  };

  return {
    debrief: async (runId) => {
      await wait(60);
      const d = byRun.get(runId);
      return d === undefined || d.state === "discarded" ? null : structuredClone(d);
    },
    startDebrief: async (runId) => {
      await wait(80);
      const run = store.get(runId);
      if (run.status !== "failed" && run.status !== "odd") throw new Error("Only a run that failed or was odd has these questions. Mark how it went first.");
      const open = byRun.get(runId);
      if (open?.state === "open") return structuredClone(open);
      made += 1;
      const d: Debrief = { id: debriefId(made), runId, state: "open", startedBy: priyaUser, startedAt: new Date().toISOString(), approvedAt: null, answers: [] };
      byRun.set(runId, d);
      return structuredClone(d);
    },
    recordAnswer: async (id, question) => {
      await wait(300);
      const d = put(find(id), question, (a) => ({ ...a, words: { kind: "recording", audio: fixtureAudio(question), heard: { kind: "transcribing" }, correction: null } }));
      setTimeout(() => {
        const now = byRun.get(d.runId);
        if (now === undefined || now.id !== id) return;
        put(now, question, (a) =>
          a.words.kind === "recording" && a.words.heard.kind === "transcribing" ? { ...a, words: { ...a.words, heard: { kind: "heard", transcript: SPOKEN[question] } } } : a,
        );
      }, TRANSCRIBE_MS);
      return d;
    },
    saveAnswerText: async (id, question, text, correction) => {
      await wait(80);
      const trimmed = text.trim();
      return put(find(id), question, (a): DebriefAnswer => {
        if (!correction) return { ...a, words: trimmed === "" ? { kind: "none" } : { kind: "typed", text: trimmed } };
        if (a.words.kind !== "recording") throw new Error("That answer couldn't be saved. Check it and try again.");
        const heard = a.words.heard.kind === "heard" ? a.words.heard.transcript.trim() : null;
        const words: AnswerWords = { ...a.words, correction: trimmed === heard ? null : trimmed };
        return { ...a, words };
      });
    },
    setFixWorked: async (id, fix) => {
      await wait(80);
      return put(find(id), 5, (a) => ({ ...a, fixWorked: fix }));
    },
    approveDebrief: async (id, useAsSuspected) => {
      await wait(150);
      const d = find(id);
      const run = store.get(d.runId);
      const words = (q: DebriefQuestion) => {
        const a = d.answers.find((x) => x.question === q);
        return a === undefined ? null : answerText(a.words);
      };
      if (d.answers.some((a) => a.words.kind === "recording" && a.words.correction === null && a.words.heard.kind === "transcribing")) {
        throw new Error("An answer is still being written out. Wait a moment, then try again.");
      }
      const cause = words(3);
      if (useAsSuspected && cause === null) throw new Error("There's no answer to question 3 to use as the suspected cause.");
      byRun.set(d.runId, { ...d, state: "approved", approvedAt: new Date().toISOString() });
      return store.put({
        ...run,
        debrief: {
          aim: words(1),
          expectedSeen: words(2),
          howFound: words(4),
          whatChanged: words(5),
          fixWorked: d.answers.find((a) => a.question === 5)?.fixWorked ?? null,
          whoElse: words(6),
          debriefedAt: new Date().toISOString(),
        },
        failure: useAsSuspected ? { ...run.failure, suspectedCause: cause, suspectedBy: priyaUser } : run.failure,
      });
    },
    discardDebrief: async (id) => {
      await wait(80);
      const d = find(id);
      byRun.set(d.runId, { ...d, state: "discarded" });
    },
  };
};

export const QUESTION_COUNT = DEBRIEF_QUESTIONS.length;
