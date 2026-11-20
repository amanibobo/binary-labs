"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { answerText, answerTo, DEBRIEF_QUESTIONS, FIX_LABELS, missingQuestions, RUN_ANSWER_FIELDS, type DebriefQuestion } from "@/lib/debrief";
import type { RunRecord } from "@/lib/run-record";
import { buttonVariants } from "../ui/button";
import { When } from "../ui/when";
import { runHref, useRunsApi } from "./runs-api";
import { RunSection, type RunSectionSlot } from "./section";

export const debriefHref = (run: Pick<RunRecord, "id">) => `${runHref(run.id)}/debrief`;

// "What happened", on a run that failed or was odd: an offer to answer the six questions, a
// way back into answers not yet saved, or the saved answers with "Missing" where nothing was
// said. Question 3 isn't a column on the run; it shows from the saved debrief.
export const DebriefSection: RunSectionSlot = ({ run }) => {
  const api = useRunsApi();
  const query = useQuery({ queryKey: ["debrief", run.id], queryFn: ({ signal }) => api.debrief(run.id, signal) });
  const debrief = query.data ?? null;
  const open = debrief?.state === "open" ? debrief : null;
  const saved = run.debrief.debriefedAt !== null;

  if (!saved) {
    const answered = open === null ? 0 : DEBRIEF_QUESTIONS.length - missingQuestions(open).length;
    return (
      <RunSection title="What happened" note="Six short questions about this run, spoken or typed. About 3 minutes.">
        {open !== null ? <p className="mb-3 text-paragraph-small text-content-secondary">You&apos;ve answered {answered} of {DEBRIEF_QUESTIONS.length}. Nothing is on the run yet.</p> : null}
        <Link href={debriefHref(run)} className={buttonVariants({ variant: open === null ? "primary" : "secondary" })}>
          {open === null ? "Answer the questions" : "Carry on"}
        </Link>
      </RunSection>
    );
  }

  const said = (question: DebriefQuestion): string | null => {
    if (question === 3) {
      const answer = debrief?.state === "approved" ? answerTo(debrief, 3) : null;
      return answer === null ? null : answerText(answer.words);
    }
    return run.debrief[RUN_ANSWER_FIELDS[question]];
  };

  return (
    <RunSection
      title="What happened"
      note={
        <>
          In the words of whoever answered, saved <When iso={run.debrief.debriefedAt ?? run.updatedAt} />.
        </>
      }
    >
      <dl className="divide-y divide-border-opaque border-y border-border-opaque">
        {DEBRIEF_QUESTIONS.map(({ question, ask }) => {
          const text = said(question);
          const fix = question === 5 ? run.debrief.fixWorked : null;
          return (
            <div key={question} className="py-3 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-6">
              <dt className="text-label-small text-content-secondary">{ask}</dt>
              <dd className="mt-1 text-paragraph-small whitespace-pre-wrap text-content-primary sm:mt-0">
                {text === null && fix === null ? <span className="text-content-tertiary">Missing</span> : text}
                {fix === null ? null : <span className="block text-content-secondary">{FIX_LABELS[fix]}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
      <Link href={debriefHref(run)} className={`${buttonVariants({ variant: "secondary", size: "compact" })} mt-4`}>
        {open === null ? "Answer again" : "Carry on with new answers"}
      </Link>
    </RunSection>
  );
};

