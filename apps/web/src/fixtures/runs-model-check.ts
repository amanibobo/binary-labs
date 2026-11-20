import type { ModelCheckApi } from "@/components/runs/model-check/api";
import { AnswerId, RunModelChecks, TaskId, type CheckSetup, type ModelAnswer, type ModelCheckRequest } from "@/lib/model-check";
import { FIRST_TRY } from "./runs";

// Dev-only screenshot data for the model check of the first try of BM3 expression, whose
// confirmed cause is a lysis buffer made at the wrong pH. Writes land in this page's copy.

const TASK = TaskId.parse("7d1c2c39-5a4e-4c55-9d7b-0c3c1a7e0001");
const answerId = (n: number) => AnswerId.parse(`7d1c2c39-5a4e-4c55-9d7b-0c3c1a7e01${String(n).padStart(2, "0")}`);

export const fixtureSetup: CheckSetup = {
  models: [
    { model: "anthropic/claude-opus-5.5", ceilingUsd: 0.37 },
    { model: "google/gemini-4-neon", ceilingUsd: 0.29 },
    { model: "openai/gpt-6.2-astra", ceilingUsd: 0.69 },
    { model: "x-ai/grok-4.7", ceilingUsd: 0.18 },
  ],
  unreachable: [],
  grader: "anthropic/claude-sonnet-5.5",
  costCapUsd: 2,
  ceilingUsd: 1.53,
  missing: [],
  ready: true,
};

const noKeys: CheckSetup = { ...fixtureSetup, models: [], grader: null, ceilingUsd: 0, missing: ["OPENROUTER_API_KEY"], ready: false };

const blank = { verdict: null, reason: null, solved: null, error: null, costUsd: 0, judgedBy: null, judgedNote: null, judgedAt: null } as const;

const answered: ModelAnswer[] = [
  {
    ...blank,
    id: answerId(1),
    model: "anthropic/claude-opus-5.5",
    state: "answered",
    answer: "The lysis buffer's pH was off. The plate shows almost no cell density difference after lysis and the gel lane is empty at 118 kDa, which fits the protein precipitating in a buffer far from pH 7.4.",
    verdict: "solved",
    reason: "It names the buffer's pH as the cause, which is the confirmed cause.",
    solved: true,
    costUsd: 0.07,
  },
  {
    ...blank,
    id: answerId(2),
    model: "google/gemini-4-neon",
    state: "answered",
    answer: "Induction failed: IPTG was most likely added at the wrong OD, so the cells never expressed BM3.",
    verdict: "not_solved",
    reason: "It blames induction, not the lysis buffer.",
    solved: false,
    costUsd: 0.05,
  },
  {
    ...blank,
    id: answerId(3),
    model: "openai/gpt-6.2-astra",
    state: "answered",
    answer: "Either the lysis buffer was wrong or the protease inhibitor was left out; the empty lane fits both.",
    verdict: "partial",
    reason: "It has the buffer among two causes without choosing one.",
    solved: null,
    costUsd: 0.12,
  },
  {
    ...blank,
    id: answerId(4),
    model: "x-ai/grok-4.7",
    state: "answered",
    answer: "The spin was too short, so the protein stayed in the pellet with the debris.",
    verdict: "not_solved",
    reason: "It names the spin, a different step.",
    solved: false,
    costUsd: 0.03,
  },
];

export type ModelCheckView = "unset" | "ready" | "checking" | "checked" | "settled" | "kept" | "runner" | "notask";

export function fixtureModelChecks(view: ModelCheckView): RunModelChecks {
  const base = {
    runId: FIRST_TRY,
    title: "BM3 expression, first try",
    setup: view === "unset" ? noKeys : fixtureSetup,
    confirmedCause: "The lysis buffer was made at pH 9 instead of pH 7.4, so BM3 came down with the debris.",
    question: "Why did the prep give no BM3 in the soluble fraction?",
    rubric: [
      { criterion: "Names the lysis buffer's pH as the cause", points: 2 },
      { criterion: "Points to the empty 118 kDa lane as the evidence", points: 1 },
    ],
    canJudge: view !== "runner",
  };
  if (view === "notask") return { ...base, tasks: [] };
  const settled = answered.map((a) => (a.solved === null ? { ...a, solved: false, judgedBy: "Jordan", judgedAt: "2026-11-20T10:12:00Z", judgedNote: "Two causes is not an answer." } : a));
  const answers =
    view === "checking"
      ? answered.map((a, i) => (i < 2 ? a : { ...blank, id: a.id, model: a.model, state: "waiting" as const, answer: null }))
      : view === "settled" || view === "kept"
        ? settled
        : answered;
  const check = view === "unset" || view === "ready" ? null : { id: "7d1c2c39-5a4e-4c55-9d7b-0c3c1a7e0002", requestedAt: "2026-11-20T09:58:00Z", costCapUsd: 2, spentUsd: answers.reduce((n, a) => n + a.costUsd, 0), answers };
  return RunModelChecks.parse({
    ...base,
    tasks: [{ taskId: TASK, builtAt: "2026-11-20T09:40:00Z", withdrawnAt: null, keptAt: view === "kept" ? "2026-11-20T10:15:00Z" : null, keptBy: view === "kept" ? "Jordan" : null, check }],
  });
}

// The model check's API for the fixture page: the view's data, and writes kept in the page.
export function createFixtureModelCheck(view: ModelCheckView): ModelCheckApi {
  let state = fixtureModelChecks(view);
  const apply = (request: ModelCheckRequest): RunModelChecks => {
    switch (request.action) {
      case "start":
        return fixtureModelChecks("checked");
      case "judge":
        return {
          ...state,
          tasks: state.tasks.map((t) => ({
            ...t,
            check: t.check === null ? null : { ...t.check, answers: t.check.answers.map((a) => (a.id === request.answerId ? { ...a, solved: request.solved, judgedBy: request.solved === null ? null : "You", judgedAt: request.solved === null ? null : new Date().toISOString(), judgedNote: request.note === "" ? null : request.note } : a)) },
          })),
        };
      case "keep":
        return { ...state, tasks: state.tasks.map((t) => ({ ...t, keptAt: request.keep ? new Date().toISOString() : null, keptBy: request.keep ? "You" : null })) };
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
  return {
    load: async () => state,
    send: async (_runId, request) => {
      state = apply(request);
      return state;
    },
  };
}
