"use client";

import { useId, useState } from "react";
import { answerText, answerTo, DEBRIEF_QUESTIONS, holdup, type AnswerWords, type Debrief, type DebriefQuestion } from "@/lib/debrief";
import { useLabApi } from "../../lab-api";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/field";
import { useRunsApi } from "../runs-api";
import { FixTaps } from "./fix-taps";

type Write = (action: () => Promise<Debrief>) => Promise<boolean>;

// Every answer beside its recording, each word editable, before anything reaches the run.
// A question with nothing said reads "Missing"; it's saved empty, never filled in.
export function DebriefReview({
  debrief,
  busy,
  write,
  onAnswer,
  onSave,
  onDiscard,
}: {
  debrief: Debrief;
  busy: boolean;
  write: Write;
  onAnswer: (question: DebriefQuestion) => void;
  onSave: (useAsSuspected: boolean) => void;
  onDiscard: () => void;
}) {
  const api = useRunsApi();
  const ids = useId();
  const [useAsSuspected, setUseAsSuspected] = useState(false);
  const cause = (() => {
    const a = answerTo(debrief, 3);
    return a === null ? null : answerText(a.words);
  })();
  const waiting = holdup(debrief);

  return (
    <>
      <h1 className="mt-6 text-heading-medium sm:text-heading-large">Check your answers</h1>
      <p className="mt-2 max-w-prose text-paragraph-medium text-content-secondary">
        Fix any words the transcript got wrong. Nothing goes on the run until you choose Save to the run.
      </p>

      <ol className="mt-8 divide-y divide-border-opaque border-y border-border-opaque">
        {DEBRIEF_QUESTIONS.map(({ question, ask }) => {
          const answer = answerTo(debrief, question);
          return (
            <li key={question} className="py-5">
              <h2 className="text-label-medium text-content-primary">
                {question}. {ask}
              </h2>
              <AnswerWordsView
                key={wordsKey(answer?.words)}
                words={answer?.words ?? { kind: "none" }}
                disabled={busy}
                onAnswer={() => onAnswer(question)}
                onSave={(text, correction) => write(() => api.saveAnswerText(debrief.id, question, text, correction))}
              />
              {question === 5 ? <FixTaps value={answer?.fixWorked ?? null} disabled={busy} onPick={(fix) => void write(() => api.setFixWorked(debrief.id, fix))} /> : null}
              {question === 3 ? (
                <label className="mt-4 flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-content-primary"
                    checked={useAsSuspected && cause !== null}
                    disabled={cause === null}
                    onChange={(e) => setUseAsSuspected(e.target.checked)}
                    aria-describedby={`${ids}-cause`}
                  />
                  <span>
                    <span className="block text-label-medium text-content-primary">Use as the run&apos;s suspected cause</span>
                    <span id={`${ids}-cause`} className="block text-paragraph-small text-content-secondary">
                      Your words above, as you wrote or said them. It stays a guess until someone confirms the cause.
                    </span>
                  </span>
                </label>
              ) : null}
            </li>
          );
        })}
      </ol>

      {waiting === null ? null : (
        <p role="status" className="mt-6 text-paragraph-small text-content-primary">
          {waiting.kind === "transcribing"
            ? `Still writing out ${listOf(waiting.questions)}. Save to the run once it's there.`
            : `We couldn't make out ${listOf(waiting.questions)}. Record it again, or type what you said.`}
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button size="large" disabled={busy || waiting !== null} onClick={() => onSave(useAsSuspected && cause !== null)}>
          Save to the run
        </Button>
        <Button size="large" variant="tertiary" disabled={busy} onClick={onDiscard}>
          Throw these answers away
        </Button>
      </div>
    </>
  );
}

function listOf(questions: readonly DebriefQuestion[]): string {
  const names = questions.map((q) => `answer ${q}`);
  return names.length === 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

// A fresh editor whenever the words underneath change (a transcript arriving, a new take).
function wordsKey(words: AnswerWords | undefined): string {
  if (words === undefined) return "none";
  switch (words.kind) {
    case "none":
      return "none";
    case "typed":
      return `typed:${words.text}`;
    case "recording":
      return `rec:${words.audio}:${words.heard.kind}:${words.correction ?? ""}`;
    default: {
      const _exhaustive: never = words;
      return _exhaustive;
    }
  }
}

function AnswerWordsView({
  words,
  disabled,
  onAnswer,
  onSave,
}: {
  words: AnswerWords;
  disabled: boolean;
  onAnswer: () => void;
  onSave: (text: string, correction: boolean) => Promise<boolean>;
}) {
  const lab = useLabApi();
  const ids = useId();
  const start = words.kind === "typed" ? words.text : words.kind === "recording" ? (words.correction ?? (words.heard.kind === "heard" ? words.heard.transcript : "")) : "";
  const [text, setText] = useState(start);

  if (words.kind === "none") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <p className="text-paragraph-small text-content-secondary">Missing. You didn&apos;t answer this.</p>
        <Button variant="secondary" size="compact" onClick={onAnswer}>
          Answer it
        </Button>
      </div>
    );
  }
  const recording = words.kind === "recording";
  const edited = recording && words.correction !== null;
  return (
    <div className="mt-3">
      {recording ? <audio controls preload="none" src={lab.mediaUrl(words.audio)} className="h-11 w-full" aria-label="Play your answer" /> : null}
      {recording && words.heard.kind === "transcribing" ? (
        <p className="mt-3 text-paragraph-small text-content-secondary">Writing out what you said…</p>
      ) : (
        <>
          {recording && words.heard.kind === "failed" ? <p className="mt-3 text-paragraph-small text-content-primary">{words.heard.message}</p> : null}
          <label htmlFor={`${ids}-words`} className="sr-only">
            {recording ? "What you said" : "What you typed"}
          </label>
          <Textarea
            id={`${ids}-words`}
            rows={3}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              if (text !== start) void onSave(text, recording);
            }}
            className="mt-3 min-h-20"
          />
          <p className="mt-1 text-paragraph-xsmall text-content-tertiary">
            {recording ? (edited ? "Your correction. The recording above is what you said." : "Written out from your recording.") : "Typed."}
          </p>
        </>
      )}
      <button type="button" onClick={onAnswer} className="mt-2 min-h-11 text-label-small text-content-secondary underline-offset-4 hover:underline sm:min-h-8">
        {recording ? "Record it again" : "Change it"}
      </button>
    </div>
  );
}
