"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { ANSWER_MAX_MS, debriefAnswerName, type DebriefQuestion } from "@/lib/debrief";
import { elapsedMs, recorderReducer } from "@/lib/recorder-state";
import { baseType, formatClock, RECORDING_BITS, recordingFormat } from "@/lib/talk-throughs";
import { MicIcon } from "../../icons/drawn";
import { Button } from "../../ui/button";

const NO_MIC = "This browser can't record here. Type your answer instead.";
const DENIED = "The microphone isn't allowed for this site. Allow it in the browser's site settings, or type your answer instead.";

// One question's recording: tap to start, tap to stop, and it goes up straight away so it can
// be written out while the next question is answered. `send` rejects with a message to show.
export function AnswerRecorder({
  question,
  hasAnswer,
  send,
}: {
  question: DebriefQuestion;
  hasAnswer: boolean;
  send: (audio: { blob: Blob; name: string }) => Promise<void>;
}) {
  const [state, dispatch] = useReducer(recorderReducer, { kind: "idle", problem: null });
  const [now, setNow] = useState(() => Date.now());
  const recorder = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    if (state.kind !== "recording") return;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (elapsedMs(state, at) >= ANSWER_MAX_MS && recorder.current?.state === "recording") recorder.current.stop();
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [state]);

  useEffect(
    () => () => {
      const r = recorder.current;
      if (r !== null && r.state !== "inactive") r.stop();
      r?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function start() {
    dispatch({ type: "discard" });
    dispatch({ type: "start" });
    const format = typeof MediaRecorder === "undefined" ? null : recordingFormat((t) => MediaRecorder.isTypeSupported(t));
    if (format === null || navigator.mediaDevices?.getUserMedia === undefined) return dispatch({ type: "problem", message: NO_MIC });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
      return dispatch({ type: "problem", message: denied ? DENIED : "We couldn't find a microphone. Type your answer instead." });
    }
    const r = new MediaRecorder(stream, { mimeType: format.mimeType, audioBitsPerSecond: RECORDING_BITS });
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    r.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (recorder.current === r) recorder.current = null;
      const type = baseType(r.mimeType || format.mimeType);
      const blob = new Blob(chunks, { type });
      const take = { blob, url: "", name: debriefAnswerName(new Date(), question, format.extension), type, durationMs: Date.now() - startedAt, madeHere: true };
      dispatch({ type: "stopped", capped: false, take });
      dispatch({ type: "send" });
      send({ blob, name: take.name }).then(
        () => dispatch({ type: "sent" }),
        (error: unknown) => dispatch({ type: "send_failed", message: error instanceof Error ? error.message : "We couldn't send that. Try again.", retryable: true }),
      );
    };
    recorder.current = r;
    r.start(1000);
    dispatch({ type: "started", at: Date.now() });
  }

  const live = state.kind === "recording";
  return (
    <div>
      {live ? (
        <div className="flex flex-wrap items-center gap-4">
          <Button size="large" className="min-h-14 w-full sm:w-auto" onClick={() => recorder.current?.stop()}>
            Stop
          </Button>
          <p aria-live="polite" className="flex items-center gap-2 text-label-medium text-content-primary">
            <span aria-hidden className="size-2.5 rounded-full bg-tint-orange motion-safe:animate-pulse" />
            Recording
            <span role="timer" aria-label="Answer length" className="font-mono text-content-secondary tabular-nums">
              {formatClock(elapsedMs(state, now))}
            </span>
          </p>
        </div>
      ) : (
        <Button
          size="large"
          variant={hasAnswer ? "secondary" : "primary"}
          className="min-h-14 w-full sm:w-auto"
          onClick={() => void start()}
          disabled={state.kind === "starting" || state.kind === "sending"}
        >
          <MicIcon className="size-5" />
          {state.kind === "sending" ? "Sending…" : hasAnswer ? "Record it again" : "Record your answer"}
        </Button>
      )}
      {state.kind === "idle" && state.problem !== null ? (
        <p role="alert" className="mt-3 text-paragraph-small text-content-primary">
          {state.problem}
        </p>
      ) : null}
      {state.kind === "send_failed" ? (
        <p role="alert" className={cn("mt-3 text-paragraph-small text-content-primary")}>
          {state.message} Record it again, or type it.
        </p>
      ) : null}
    </div>
  );
}
