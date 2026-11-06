import type { Answer, AnswerSentence, AnswerSource, AskEvent, Budget, SavedAnswer, Verdict } from "./answers";
import type { QuestionId } from "./ids";

// The answer panel on the Search page, as a state machine fed by the ask route's events.

export type AskState =
  | { kind: "idle" }
  // Sources are null until retrieval answers; sentences arrive one at a time after.
  | { kind: "asking"; question: string; sources: AnswerSource[] | null; sentences: AnswerSentence[] }
  | {
      kind: "answered";
      question: string;
      questionId: QuestionId;
      sources: AnswerSource[];
      answer: Answer;
      outcome: "answered" | "not_found";
      verdict: Verdict | null;
    }
  | { kind: "limit"; question: string; sources: AnswerSource[]; budget: Budget }
  | { kind: "failed"; question: string; sources: AnswerSource[]; message: string };

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
      return { kind: "asking", question: action.question, sources: null, sentences: [] };
    case "close":
      return { kind: "idle" };
    case "opened":
      return {
        kind: "answered",
        question: action.saved.question,
        questionId: action.saved.id,
        sources: action.saved.sources,
        answer: action.saved.answer,
        outcome: action.saved.outcome,
        verdict: action.saved.myVerdict,
      };
    case "verdict":
      return state.kind === "answered" ? { ...state, verdict: action.verdict } : state;
    case "lost":
      return state.kind === "asking" ? { kind: "failed", question: state.question, sources: state.sources ?? [], message: action.message } : state;
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
  switch (event.type) {
    case "sources":
      return { ...state, sources: event.sources };
    case "sentence":
      return { ...state, sentences: [...state.sentences, event.sentence] };
    case "limit":
      return { kind: "limit", question: state.question, sources: state.sources ?? [], budget: event.budget };
    case "failed":
      return { kind: "failed", question: state.question, sources: state.sources ?? [], message: event.message };
    case "done":
      return {
        kind: "answered",
        question: state.question,
        questionId: event.questionId,
        sources: state.sources ?? [],
        answer: event.answer,
        outcome: event.outcome,
        verdict: null,
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

const monthDay = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

export function limitMessage(budget: Budget): string {
  const cap = budget.capUsd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  return `This lab has used its ${cap} for questions this month. Asking works again on ${monthDay.format(new Date(budget.resetsAt))}.`;
}
