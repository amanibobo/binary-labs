"use client";

import Link from "next/link";
import { useCallback, useId, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { QUESTIONS_HREF, RECENT_QUESTIONS_SHOWN, type AskHome, type RecentQuestion, type Verdict } from "@/lib/answers";
import { askReducer, type AskState } from "@/lib/ask-state";
import type { QuestionId, UserId } from "@/lib/ids";
import { When } from "../ui/when";
import { useAskApi } from "./ask-api";

export type { AskHome };

const LOST = "The answer stopped coming. Try again.";

function setAskParam(id: QuestionId | null) {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete("ask");
  else url.searchParams.set("ask", id);
  window.history.replaceState(null, "", url);
}

export function useAsk() {
  const api = useAskApi();
  const [state, dispatch] = useReducer(askReducer, { kind: "idle" } satisfies AskState);
  // Counts questions asked and answers opened, so each one gets a fresh answer box.
  const [round, setRound] = useState(0);
  const current = useRef<AbortController | null>(null);

  const ask = useCallback(
    (question: string) => {
      current.current?.abort();
      const controller = new AbortController();
      current.current = controller;
      dispatch({ type: "ask", question });
      setRound((r) => r + 1);
      setAskParam(null);
      api
        .ask(
          question,
          (event) => {
            if (controller.signal.aborted) return;
            dispatch({ type: "event", event });
            if (event.type === "done") setAskParam(event.questionId);
          },
          controller.signal,
        )
        .then(() => {
          if (!controller.signal.aborted) dispatch({ type: "lost", message: LOST });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) dispatch({ type: "lost", message: error instanceof Error ? error.message : LOST });
        });
    },
    [api],
  );

  const open = useCallback(
    (id: QuestionId) => {
      current.current?.abort();
      const controller = new AbortController();
      current.current = controller;
      api
        .answer(id, controller.signal)
        .then((saved) => {
          if (controller.signal.aborted) return;
          dispatch({ type: "opened", saved });
          setRound((r) => r + 1);
          setAskParam(saved.id);
        })
        .catch(() => {
          if (!controller.signal.aborted) toast.error("We couldn't open that answer.");
        });
    },
    [api],
  );

  const close = useCallback(() => {
    current.current?.abort();
    dispatch({ type: "close" });
    setAskParam(null);
  }, []);

  const verdict = useCallback(
    (id: QuestionId, value: Verdict) => {
      dispatch({ type: "verdict", verdict: value });
      api.feedback(id, value).catch(() => toast.error("We couldn't save that. Try again."));
    },
    [api],
  );

  return { state, round, ask, open, close, verdict };
}

export function asker(q: RecentQuestion, viewerId: UserId | null): string {
  if (q.askedBy !== null && q.askedBy === viewerId) return "You";
  return q.askedByEmail?.split("@")[0] ?? "Someone";
}

export const questionRow =
  "flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-1.5 text-left transition-colors duration-150 ease-out hover:bg-background-secondary focus-visible:outline-offset-[-2px] sm:flex-row sm:items-baseline sm:justify-between sm:gap-4";

// The question, then who asked and when, and a quiet "No answer" when the records had none.
export function QuestionRowText({ q, viewerId }: { q: RecentQuestion; viewerId: UserId | null }) {
  return (
    <>
      <span className="max-w-full min-w-0 truncate text-paragraph-small text-content-primary sm:flex-1">{q.question}</span>
      <span className="shrink-0 text-paragraph-xsmall text-content-tertiary">
        {asker(q, viewerId)} · <When iso={q.askedAt} />
        {q.outcome === "not_found" ? " · No answer" : ""}
      </span>
    </>
  );
}

// The lab's latest questions on the Search home, each opening its saved answer: three, and
// "Show all" when there are more, which leads to the Questions page with its search.
export function RecentQuestions({ home, onOpen }: { home: AskHome; onOpen: (q: RecentQuestion) => void }) {
  const headingId = useId();
  if (home.recent.length === 0 && home.openSuggestions === 0) return null;
  const more = home.recent.length > RECENT_QUESTIONS_SHOWN;
  return (
    <section aria-labelledby={headingId} className="mb-10">
      <h2 id={headingId} className="mb-1 px-3 text-label-small text-content-tertiary">
        Recent questions
      </h2>
      <ul>
        {home.recent.slice(0, RECENT_QUESTIONS_SHOWN).map((q) => (
          <li key={q.id}>
            <button type="button" onClick={() => onOpen(q)} className={questionRow}>
              <QuestionRowText q={q} viewerId={home.viewerId} />
            </button>
          </li>
        ))}
      </ul>
      {more ? (
        <Link
          href={QUESTIONS_HREF}
          className="mt-0.5 inline-flex rounded-xl px-3 py-1.5 text-paragraph-small text-content-tertiary transition-colors duration-150 ease-out hover:text-content-primary focus-visible:outline-offset-[-2px] max-sm:min-h-11 max-sm:items-center"
        >
          Show all questions
        </Link>
      ) : null}
      {home.openSuggestions > 0 ? (
        <Link href="/suggestions" className="mt-1 block w-fit rounded-xl px-3 py-1.5 text-paragraph-small text-content-accent hover:underline">
          {home.openSuggestions === 1 ? "1 suggestion is waiting for approval" : `${home.openSuggestions} suggestions are waiting for approval`}
        </Link>
      ) : null}
    </section>
  );
}
