import type { Answer, AnswerSentence, AnswerSource, AskEvent, AskStep, Budget, SavedAnswer, Verdict } from "./answers";
import type { QuestionId } from "./ids";

// The answer box on the Search page, as a state machine fed by the ask route's events.

export type AskState =
  | { kind: "idle" }
  // Sources are null until retrieval answers; steps arrive as the work happens, sentences after.
  | { kind: "asking"; question: string; steps: AskStep[]; sources: AnswerSource[] | null; sentences: AnswerSentence[] }
  | {
      kind: "answered";
      question: string;
      questionId: QuestionId;
      steps: AskStep[];
      sources: AnswerSource[];
      answer: Answer;
      outcome: "answered" | "not_found";
      verdict: Verdict | null;
      // When it was asked, for an answer opened again from the lab's recent questions.
      askedAt: string | null;
    }
  | { kind: "limit"; question: string; steps: AskStep[]; sources: AnswerSource[]; budget: Budget }
  | { kind: "failed"; question: string; steps: AskStep[]; sources: AnswerSource[]; message: string };

export type AskAction =
  | { type: "ask"; question: string }
  | { type: "event"; event: AskEvent }
  | { type: "opened"; saved: SavedAnswer }
  | { type: "verdict"; verdict: Verdict }
  | { type: "lost"; message: string }
  | { type: "close" };

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case "ask":
      return { kind: "asking", question: action.question, steps: [], sources: null, sentences: [] };
    case "close":
      return { kind: "idle" };
    case "opened":
      return {
        kind: "answered",
        question: action.saved.question,
        questionId: action.saved.id,
        steps: action.saved.steps,
        sources: action.saved.sources,
        answer: action.saved.answer,
        outcome: action.saved.outcome,
        verdict: action.saved.myVerdict,
        askedAt: action.saved.askedAt,
      };
    case "verdict":
      return state.kind === "answered" ? { ...state, verdict: action.verdict } : state;
    case "lost":
      return state.kind === "asking"
        ? { kind: "failed", question: state.question, steps: state.steps, sources: state.sources ?? [], message: action.message }
        : state;
    case "event":
      return onEvent(state, action.event);
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function onEvent(state: AskState, event: AskEvent): AskState {
  // Events from a question the person has moved on from are ignored.
  if (state.kind !== "asking") return state;
  const common = { question: state.question, steps: state.steps, sources: state.sources ?? [] };
  switch (event.type) {
    case "step":
      return { ...state, steps: upsertStep(state.steps, event.step) };
    case "sources":
      return { ...state, sources: event.sources };
    case "sentence":
      return { ...state, sentences: [...state.sentences, event.sentence] };
    case "limit":
      return { kind: "limit", ...common, budget: event.budget };
    case "failed":
      return { kind: "failed", ...common, message: event.message };
    case "done":
      return { kind: "answered", ...common, questionId: event.questionId, answer: event.answer, outcome: event.outcome, verdict: null, askedAt: null };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

// A step sent again (a search that finished) replaces the one with its id; the list stays in
// the order the steps started.
export function upsertStep(steps: readonly AskStep[], step: AskStep): AskStep[] {
  const at = steps.findIndex((s) => s.id === step.id);
  if (at >= 0) return steps.map((s, i) => (i === at ? step : s));
  return [...steps, step].sort((a, b) => a.id - b.id);
}

// --- The activity list ---

type StepOf<K extends AskStep["kind"]> = Extract<AskStep, { kind: K }>;

// One line of the activity list: a search or the writing on its own, and files, protocols or
// tables read one after another on one line, as chips.
export type ActivityRow =
  | { kind: "search"; step: StepOf<"search"> }
  | { kind: "file"; steps: StepOf<"file">[] }
  | { kind: "protocol"; steps: StepOf<"protocol">[] }
  | { kind: "table"; steps: StepOf<"table">[] }
  | { kind: "write"; step: StepOf<"write"> };

export function activityRows(steps: readonly AskStep[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const step of steps) {
    const last = rows.at(-1);
    switch (step.kind) {
      case "search":
        rows.push({ kind: "search", step });
        break;
      case "write":
        rows.push({ kind: "write", step });
        break;
      case "file":
        if (last?.kind === "file") last.steps.push(step);
        else rows.push({ kind: "file", steps: [step] });
        break;
      case "protocol":
        if (last?.kind === "protocol") last.steps.push(step);
        else rows.push({ kind: "protocol", steps: [step] });
        break;
      case "table":
        if (last?.kind === "table") last.steps.push(step);
        else rows.push({ kind: "table", steps: [step] });
        break;
      default: {
        const _exhaustive: never = step;
        return _exhaustive;
      }
    }
  }
  return rows;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function listWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function searchedWords(n: number): string {
  if (n === 1) return "Searched once";
  if (n === 2) return "Searched twice";
  return `Searched ${n} times`;
}

// The collapsed list in one line: "Searched once · read 4 files, 1 protocol and 1 table".
export function activitySummary(steps: readonly AskStep[]): string {
  const n = (kind: AskStep["kind"]) => steps.filter((s) => s.kind === kind).length;
  const read = [
    n("file") > 0 ? count(n("file"), "file", "files") : null,
    n("protocol") > 0 ? count(n("protocol"), "protocol", "protocols") : null,
    n("table") > 0 ? count(n("table"), "table", "tables") : null,
  ].filter((p) => p !== null);
  const searched = searchedWords(n("search"));
  return read.length === 0 ? `${searched} · nothing matched` : `${searched} · read ${listWords(read)}`;
}

export function searchResultWords(found: NonNullable<StepOf<"search">["found"]>): string {
  const parts = [found.files > 0 || found.protocols === 0 ? count(found.files, "file", "files") : null, found.protocols > 0 ? count(found.protocols, "protocol", "protocols") : null];
  return listWords(parts.filter((p) => p !== null));
}

export function tableWords(step: StepOf<"table">): string {
  return `${count(step.rows, "row", "rows")}, ${count(step.cells, "cell", "cells")}`;
}

const monthDay = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

export function limitMessage(budget: Budget): string {
  const cap = budget.capUsd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  return `This lab has used its ${cap} for questions this month. Asking works again on ${monthDay.format(new Date(budget.resetsAt))}.`;
}
