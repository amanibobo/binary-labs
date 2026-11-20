"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import {
  answerTo,
  DEBRIEF_QUESTIONS,
  isTranscribing,
  missingQuestions,
  type AnswerWords,
  type Debrief,
  type DebriefQuestion,
} from "@/lib/debrief";
import type { RunId } from "@/lib/ids";
import { Breadcrumbs } from "../../ui/breadcrumbs";
import { Button, buttonVariants } from "../../ui/button";
import { Textarea } from "../../ui/field";
import { runHref, useRunsApi } from "../runs-api";
import { AnswerRecorder } from "./answer-recorder";
import { DebriefReview } from "./debrief-review";
import { FixTaps } from "./fix-taps";

const POLL_MS = 1_500;

export type Screen = { kind: "start" } | { kind: "question"; question: DebriefQuestion } | { kind: "review" };

// Where someone coming back lands: the first question with nothing said, or the review once
// every question has something.
export function firstScreen(debrief: Debrief | null): Screen {
  if (debrief === null || debrief.state !== "open") return { kind: "start" };
  const missing = missingQuestions(debrief);
  return missing[0] === undefined ? { kind: "review" } : { kind: "question", question: missing[0] };
}

const next = (q: DebriefQuestion): DebriefQuestion | null => DEBRIEF_QUESTIONS.find((d) => d.question === q + 1)?.question ?? null;
const previous = (q: DebriefQuestion): DebriefQuestion | null => DEBRIEF_QUESTIONS.find((d) => d.question === q - 1)?.question ?? null;

// The debrief of a run that failed or was odd: one question per screen, each answered by a
// short recording or typed, then a review where the scientist checks every word before
// anything reaches the run.
export function DebriefFlow({ run, initial, startAt }: { run: { id: RunId; title: string }; initial: Debrief | null; startAt?: Screen }) {
  const api = useRunsApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const key = ["debrief", run.id];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.debrief(run.id, signal),
    initialData: initial,
    refetchInterval: (q) => (q.state.data != null && isTranscribing(q.state.data) ? POLL_MS : false),
  });
  const open = query.data?.state === "open" ? query.data : null;
  const [screen, setScreen] = useState<Screen>(() => startAt ?? firstScreen(initial));
  const [busy, setBusy] = useState(false);
  const setDebrief = (d: Debrief) => queryClient.setQueryData(key, d);

  // An answer's words save on blur, which lands just before a click on Save to the run; the
  // save waits for them rather than the button being disabled under the click.
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const write = async (action: () => Promise<Debrief>): Promise<boolean> => {
    const saving = action();
    pending.current = saving.catch(() => undefined);
    try {
      setDebrief(await saving);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
      return false;
    }
  };

  const crumbs = <Breadcrumbs items={[{ label: "Runs", href: "/runs" }, { label: run.title, href: runHref(run.id) }, { label: "What happened", href: `${runHref(run.id)}/debrief` }]} />;

  if (screen.kind === "start" || open === null) {
    return (
      <Page crumbs={crumbs}>
        <h1 className="mt-6 text-heading-medium sm:text-heading-large">What happened in this run?</h1>
        <p className="mt-3 max-w-prose text-paragraph-medium text-content-secondary">
          Six short questions, one at a time. Answer each by speaking or typing. It takes about 3 minutes, and nothing goes on the run until you&apos;ve checked your
          answers.
        </p>
        {query.data?.state === "approved" ? (
          <p className="mt-2 max-w-prose text-paragraph-small text-content-tertiary">Your new answers will replace the ones saved on the run.</p>
        ) : null}
        <div className="mt-8 flex flex-wrap gap-3">
          <Button
            size="large"
            disabled={busy}
            onClick={async () => {
              let opened = open;
              if (opened === null) {
                setBusy(true);
                opened = await api.startDebrief(run.id).catch((error: unknown) => {
                  toast.error(error instanceof Error ? error.message : "We couldn't start. Try again.");
                  return null;
                });
                setBusy(false);
                if (opened === null) return;
                setDebrief(opened);
              }
              setScreen(firstScreen(opened));
            }}
          >
            {open === null ? "Start" : "Carry on"}
          </Button>
          <Link href={runHref(run.id)} className={buttonVariants({ variant: "tertiary", size: "large" })}>
            Not now
          </Link>
        </div>
      </Page>
    );
  }

  if (screen.kind === "review") {
    return (
      <Page crumbs={crumbs}>
        <DebriefReview
          debrief={open}
          busy={busy}
          write={write}
          onAnswer={(question) => setScreen({ kind: "question", question })}
          onSave={async (useAsSuspected) => {
            setBusy(true);
            try {
              await pending.current;
              const saved = await api.approveDebrief(open.id, useAsSuspected);
              queryClient.removeQueries({ queryKey: key });
              toast.success("Saved to the run.");
              router.push(runHref(saved.id));
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
              setBusy(false);
            }
          }}
          onDiscard={async () => {
            setBusy(true);
            try {
              await api.discardDebrief(open.id);
              queryClient.removeQueries({ queryKey: key });
              router.push(runHref(run.id));
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "We couldn't do that. Try again.");
              setBusy(false);
            }
          }}
        />
      </Page>
    );
  }

  return (
    <Page crumbs={crumbs}>
      <QuestionScreen
        key={screen.question}
        debrief={open}
        question={screen.question}
        busy={busy}
        write={write}
        setDebrief={setDebrief}
        go={(to) => setScreen(to === null ? { kind: "review" } : { kind: "question", question: to })}
        back={() => {
          const to = previous(screen.question);
          if (to === null) router.push(runHref(run.id));
          else setScreen({ kind: "question", question: to });
        }}
      />
    </Page>
  );
}

function Page({ crumbs, children }: { crumbs: React.ReactNode; children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 sm:px-8 sm:pt-10">{crumbs}{children}</div>;
}

type Write = (action: () => Promise<Debrief>) => Promise<boolean>;

function QuestionScreen({
  debrief,
  question,
  busy,
  write,
  setDebrief,
  go,
  back,
}: {
  debrief: Debrief;
  question: DebriefQuestion;
  busy: boolean;
  write: Write;
  setDebrief: (d: Debrief) => void;
  go: (to: DebriefQuestion | null) => void;
  back: () => void;
}) {
  const api = useRunsApi();
  const ids = useId();
  const answer = answerTo(debrief, question);
  const words: AnswerWords = answer?.words ?? { kind: "none" };
  const [typing, setTyping] = useState(words.kind === "typed");
  const [text, setText] = useState(words.kind === "typed" ? words.text : "");
  const ask = DEBRIEF_QUESTIONS[question - 1];
  const said = words.kind !== "none";
  const answered = said || (question === 5 && answer?.fixWorked != null);
  const to = next(question);

  return (
    <>
      <p className="mt-6 text-label-small text-content-tertiary tabular-nums">
        Question {question} of {DEBRIEF_QUESTIONS.length}
      </p>
      <h1 id={`${ids}-ask`} className="mt-1 text-heading-medium sm:text-heading-large">
        {ask?.ask}
      </h1>
      <p className="mt-2 max-w-prose text-paragraph-medium text-content-secondary">{ask?.hint}</p>

      <div className="mt-8">
        {typing ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await write(() => api.saveAnswerText(debrief.id, question, text, false))) go(to);
            }}
          >
            <Textarea aria-labelledby={`${ids}-ask`} rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus className="min-h-28" />
            <div className="mt-3 flex flex-wrap gap-3">
              <Button type="submit" disabled={busy}>
                Save answer
              </Button>
              <Button type="button" variant="tertiary" onClick={() => setTyping(false)}>
                Speak instead
              </Button>
            </div>
          </form>
        ) : (
          <>
            <Said words={words} />
            <div className={cn(said && "mt-4")}>
              <AnswerRecorder
                question={question}
                hasAnswer={words.kind === "recording"}
                send={async (audio) => setDebrief(await api.recordAnswer(debrief.id, question, audio))}
              />
            </div>
            <button type="button" onClick={() => setTyping(true)} className="mt-3 min-h-11 text-label-small text-content-secondary underline-offset-4 hover:underline sm:min-h-8">
              Type instead
            </button>
          </>
        )}
      </div>

      {question === 5 ? <FixTaps value={answer?.fixWorked ?? null} disabled={busy} onPick={(fix) => void write(() => api.setFixWorked(debrief.id, fix))} /> : null}

      <div className="mt-12 flex items-center justify-between gap-3 border-t border-border-opaque pt-5">
        <Button variant="tertiary" onClick={back}>
          Back
        </Button>
        <Button variant={answered ? "primary" : "secondary"} onClick={() => go(to)}>
          {to === null ? "Check your answers" : answered ? "Next" : "Skip for now"}
        </Button>
      </div>
    </>
  );
}

// What's held for this question so far, as the question screen shows it.
function Said({ words }: { words: AnswerWords }) {
  switch (words.kind) {
    case "none":
      return null;
    case "typed":
      return <Quote label="You typed">{words.text}</Quote>;
    case "recording":
      switch (words.heard.kind) {
        case "transcribing":
          return <p className="text-paragraph-small text-content-secondary">Writing out what you said. You can go on to the next question.</p>;
        case "failed":
          return <p className="text-paragraph-small text-content-primary">{words.heard.message}</p>;
        case "heard":
          return <Quote label="We heard">{words.correction ?? words.heard.transcript}</Quote>;
        default: {
          const _exhaustive: never = words.heard;
          return _exhaustive;
        }
      }
    default: {
      const _exhaustive: never = words;
      return _exhaustive;
    }
  }
}

function Quote({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="max-w-prose">
      <p className="text-label-small text-content-tertiary">{label}</p>
      <p className="mt-1 text-paragraph-medium whitespace-pre-wrap text-content-primary">{children}</p>
    </div>
  );
}
