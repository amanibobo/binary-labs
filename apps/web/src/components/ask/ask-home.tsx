"use client";

import Link from "next/link";
import { useCallback, useId, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { RECENT_QUESTIONS_SHOWN, type AskHome, type RecentQuestion, type Verdict } from "@/lib/answers";
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

function asker(q: RecentQuestion, viewerId: UserId | null): string {
  if (q.askedBy !== null && q.askedBy === viewerId) return "You";
  return q.askedByEmail?.split("@")[0] ?? "Someone";
}

// The lab's latest questions on the Search home, each opening its saved answer: three, and the
// rest of the latest ten behind "Show all". A question the records couldn't answer just says so.
export function RecentQuestions({ home, onOpen }: { home: AskHome; onOpen: (q: RecentQuestion) => void }) {
  const headingId = useId();
  const listId = useId();
  const [all, setAll] = useState(false);
  if (home.recent.length === 0 && home.openSuggestions === 0) return null;
  const hidden = home.recent.length - RECENT_QUESTIONS_SHOWN;
  const shown = all ? home.recent : home.recent.slice(0, RECENT_QUESTIONS_SHOWN);
  return (
    <section aria-labelledby={headingId} className="mb-10">
      <div className="mb-1 flex items-baseline justify-between gap-4 px-3">
        <h2 id={headingId} className="text-label-small text-content-tertiary">
          Recent questions
        </h2>
        {hidden > 0 ? (
          <button
            type="button"
            aria-expanded={all}
            aria-controls={listId}
            onClick={() => setAll((a) => !a)}
            className="-mx-1 rounded-md px-1 text-paragraph-xsmall text-content-tertiary hover:text-content-primary max-sm:min-h-11"
          >
            {all ? "Show fewer" : `Show all ${home.recent.length}`}
          </button>
        ) : null}
      </div>
      <ul id={listId}>
        {shown.map((q) => (
          <li key={q.id}>
            <button
              type="button"
              onClick={() => onOpen(q)}
              className="flex w-full flex-col items-start gap-0.5 rounded-xl px-3 py-1.5 text-left transition-colors duration-150 ease-out hover:bg-background-secondary focus-visible:outline-offset-[-2px] sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
            >
              <span className="min-w-0 truncate text-paragraph-small text-content-primary sm:flex-1">{q.question}</span>
              <span className="shrink-0 text-paragraph-xsmall text-content-tertiary">
                {asker(q, home.viewerId)} · <When iso={q.askedAt} />
                {q.outcome === "not_found" ? " · Not in the files" : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {home.openSuggestions > 0 ? (
        <Link href="/suggestions" className="mt-1 block w-fit rounded-xl px-3 py-1.5 text-paragraph-small text-content-accent hover:underline">
          {home.openSuggestions === 1 ? "1 suggestion is waiting for approval" : `${home.openSuggestions} suggestions are waiting for approval`}
        </Link>
      ) : null}
    </section>
  );
}
