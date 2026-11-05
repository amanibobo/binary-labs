"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { formatSize } from "@/lib/format";
import { protocolHref } from "@/lib/protocols";
import {
  AUDIO_MAX_BYTES,
  baseType,
  formatClock,
  RECORDING_BITS,
  RECORDING_MAX_MS,
  RECORDING_WARN_MS,
  recordingFormat,
  recordingName,
  refusedRecording,
  talkThroughHref,
  TOO_LONG,
  type TalkThroughTarget,
} from "@/lib/talk-throughs";
import { elapsedMs, recorderReducer, takeOf, type RecorderState, type Take } from "@/lib/recorder-state";
import { localDay } from "@/lib/uploads";
import { FileAudioIcon, MicIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { CrumbBar } from "../protocols/crumb-bar";
import { Button, buttonVariants } from "../ui/button";

const NO_MIC = "This browser can't record here. Use a recording you already have instead.";
const DENIED = "The microphone isn't allowed for this site. Allow it in the browser's site settings, or add a recording you already have.";

export function Recorder({
  target,
  pageTitle,
  initial = { kind: "idle", problem: null },
}: {
  target: TalkThroughTarget;
  // The page this is for; null for a new page.
  pageTitle: string | null;
  initial?: RecorderState;
}) {
  const api = useLabApi();
  const router = useRouter();
  const [state, dispatch] = useReducer(recorderReducer, initial);
  const [now, setNow] = useState(() => Date.now());
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const capped = useRef(false);
  const ids = useId();

  // The clock ticks only while recording; the cap stops it by itself.
  useEffect(() => {
    if (state.kind !== "recording") return;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (elapsedMs(state, at) >= RECORDING_MAX_MS && recorder.current?.state === "recording") {
        capped.current = true;
        recorder.current.stop();
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [state]);

  const takeUrl = takeOf(state)?.url ?? null;
  useEffect(() => (takeUrl === null ? undefined : () => URL.revokeObjectURL(takeUrl)), [takeUrl]);

  const unsent = state.kind !== "idle" && state.kind !== "sent";
  useEffect(() => {
    if (!unsent) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsent]);

  useEffect(
    () => () => {
      const r = recorder.current;
      if (r !== null && r.state !== "inactive") r.stop();
      r?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function start() {
    dispatch({ type: "start" });
    const format = typeof MediaRecorder === "undefined" ? null : recordingFormat((t) => MediaRecorder.isTypeSupported(t));
    if (format === null || navigator.mediaDevices?.getUserMedia === undefined) return dispatch({ type: "problem", message: NO_MIC });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
      return dispatch({ type: "problem", message: denied ? DENIED : "We couldn't find a microphone. Use a recording you already have instead." });
    }
    const r = new MediaRecorder(stream, { mimeType: format.mimeType, audioBitsPerSecond: RECORDING_BITS });
    chunks.current = [];
    capped.current = false;
    // The length as the recorder heard it; WebM from MediaRecorder carries no duration of its own.
    let banked = 0;
    let since = Date.now();
    let running = true;
    r.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    r.onpause = () => {
      banked += Date.now() - since;
      running = false;
    };
    r.onresume = () => {
      since = Date.now();
      running = true;
    };
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (recorder.current === r) recorder.current = null;
      const durationMs = Math.max(1, Math.min(RECORDING_MAX_MS, banked + (running ? Date.now() - since : 0)));
      const type = baseType(r.mimeType || format.mimeType);
      const blob = new Blob(chunks.current, { type });
      dispatch({
        type: "stopped",
        capped: capped.current,
        take: { blob, url: URL.createObjectURL(blob), name: recordingName(new Date(), format.extension), type, durationMs, madeHere: true },
      });
    };
    recorder.current = r;
    // A slice a second keeps what's said so far if the tab is killed mid-way.
    r.start(1000);
    since = Date.now();
    dispatch({ type: "started", at: since });
  }

  function pause() {
    const r = recorder.current;
    if (r?.state !== "recording") return;
    r.pause();
    dispatch({ type: "pause", at: Date.now() });
  }

  function resume() {
    const r = recorder.current;
    if (r?.state !== "paused") return;
    r.resume();
    dispatch({ type: "resume", at: Date.now() });
  }

  function stop() {
    recorder.current?.stop();
  }

  function pick(file: File) {
    const type = baseType(file.type);
    const refused = refusedRecording(type);
    if (refused !== null) return dispatch({ type: "problem", message: "That file isn't a sound recording. Pick an audio file, like a voice memo." });
    if (file.size > AUDIO_MAX_BYTES) return dispatch({ type: "problem", message: TOO_LONG });
    if (file.size === 0) return dispatch({ type: "problem", message: "That file is empty." });
    const url = URL.createObjectURL(file);
    dispatch({ type: "picked", take: { blob: file, url, name: file.name, type, durationMs: null, madeHere: false } });
    const probe = new Audio();
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      if (Number.isFinite(probe.duration) && probe.duration > 0) {
        dispatch({ type: "duration", ms: Math.round(probe.duration * 1000) });
      }
    };
    probe.src = url;
  }

  async function send(t: Take) {
    dispatch({ type: "send" });
    const now = new Date();
    const result = await api.uploadTalkThrough(
      t.blob,
      {
        name: t.name,
        uploadedOn: localDay(now),
        modifiedAt: !t.madeHere && t.blob instanceof File && t.blob.lastModified > 0 ? t.blob.lastModified : null,
        target,
        durationMs: t.durationMs,
      },
      (sent) => dispatch({ type: "progress", sent }),
      new AbortController().signal,
    );
    switch (result.kind) {
      case "stored":
        dispatch({ type: "sent" });
        router.push(talkThroughHref(result.receipt.talkThroughId));
        return;
      case "refused":
        dispatch({ type: "send_failed", message: result.message, retryable: false });
        return;
      case "interrupted":
        dispatch({ type: "send_failed", message: result.message, retryable: true });
        return;
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  const backHref = target.kind === "page" ? protocolHref(target.protocolId) : "/protocols/new";
  const elapsed = elapsedMs(state, now);
  const live = state.kind === "recording" || state.kind === "paused";

  return (
    <>
      <CrumbBar
        items={[
          target.kind === "page" ? { label: pageTitle ?? "Protocol", href: backHref } : { label: "New protocol", href: backHref },
          { label: "Talk-through", href: "/talk-throughs/new" },
        ]}
        width="max-w-2xl sm:px-8"
      />
      <div className="mx-auto w-full max-w-2xl px-4 pt-8 pb-24 sm:px-8 sm:pt-12">
        <h1 className="text-heading-medium sm:text-heading-large">Record a talk-through</h1>
        {pageTitle !== null ? <p className="mt-1 text-paragraph-small text-content-tertiary">For {pageTitle}</p> : null}
        <p className="mt-2 max-w-prose text-paragraph-medium text-content-secondary">
          Say how you do it, step by step, as you would to someone new. You check the written steps before anything is saved.
        </p>

        <section aria-labelledby={`${ids}-panel`} className="mt-8 rounded-control border border-border-opaque bg-background-raised p-5 sm:p-8">
          <h2 id={`${ids}-panel`} className="sr-only">
            Recording
          </h2>
          <div className="flex items-center justify-between gap-4">
            <p aria-live="polite" className="flex items-center gap-2.5 text-label-medium text-content-primary">
              <span
                aria-hidden
                className={cn(
                  "size-2.5 rounded-full",
                  state.kind === "recording" ? "bg-tint-orange motion-safe:animate-pulse" : live ? "bg-tint-orange/50" : "bg-background-tertiary",
                )}
              />
              {statusLine(state)}
            </p>
            <p role="timer" aria-label="Recording length" className="font-mono text-heading-medium text-content-primary tabular-nums sm:text-heading-large">
              {formatClock(elapsed)}
            </p>
          </div>
          <p className="mt-1 text-paragraph-small text-content-tertiary tabular-nums">
            {state.kind === "recording" && elapsed >= RECORDING_WARN_MS
              ? `${formatClock(RECORDING_MAX_MS - elapsed)} left. Recording stops at ${formatClock(RECORDING_MAX_MS)}.`
              : `Up to ${RECORDING_MAX_MS / 60_000} minutes. Pause whenever you need to.`}
          </p>

          <Controls
            state={state}
            onStart={() => void start()}
            onPause={pause}
            onResume={resume}
            onStop={stop}
            onSend={(t) => void send(t)}
            onDiscard={() => dispatch({ type: "discard" })}
          />
        </section>

        {state.kind === "idle" && state.problem !== null ? (
          <p role="alert" className="mt-4 rounded-control border border-border-raised bg-background-secondary px-4 py-3 text-paragraph-small text-content-primary">
            {state.problem}
          </p>
        ) : null}

        {state.kind === "idle" || state.kind === "recorded" ? <FileOption onPick={pick} /> : null}

        <Link href={backHref} className={cn(buttonVariants({ variant: "tertiary" }), "mt-8 -ml-3")}>
          Cancel
        </Link>
      </div>
    </>
  );
}

function statusLine(state: RecorderState): string {
  switch (state.kind) {
    case "idle":
      return "Ready to record";
    case "starting":
      return "Asking for the microphone";
    case "recording":
      return "Recording";
    case "paused":
      return "Paused";
    case "recorded":
      return state.capped ? "Stopped at the 30-minute limit" : state.take.madeHere ? "Recorded" : "Recording chosen";
    case "sending":
      return "Sending";
    case "send_failed":
      return "Not sent yet";
    case "sent":
      return "Sent";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function Controls({
  state,
  onStart,
  onPause,
  onResume,
  onStop,
  onSend,
  onDiscard,
}: {
  state: RecorderState;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onSend: (take: Take) => void;
  onDiscard: () => void;
}) {
  const row = "mt-6 grid gap-3 sm:flex sm:flex-wrap";
  const big = "min-h-14 w-full sm:w-auto";
  switch (state.kind) {
    case "idle":
    case "starting":
      return (
        <div className={row}>
          <Button size="large" className={big} onClick={onStart} disabled={state.kind === "starting"}>
            <MicIcon className="size-5" />
            Start recording
          </Button>
        </div>
      );
    case "recording":
    case "paused":
      return (
        <div className={cn(row, "grid-cols-2")}>
          <Button size="large" variant="secondary" className={big} onClick={state.kind === "recording" ? onPause : onResume}>
            {state.kind === "recording" ? "Pause" : "Resume"}
          </Button>
          <Button size="large" className={big} onClick={onStop}>
            Stop
          </Button>
        </div>
      );
    case "recorded":
    case "send_failed":
      return (
        <>
          <TakeCard take={state.take} />
          {state.kind === "send_failed" ? (
            <p role="alert" className="mt-3 text-paragraph-small text-content-primary">
              {state.message}
            </p>
          ) : null}
          <div className={row}>
            {state.kind === "recorded" || state.retryable ? (
              <Button size="large" className={big} onClick={() => onSend(state.take)}>
                {state.kind === "send_failed" ? "Try sending again" : "Write up the steps"}
              </Button>
            ) : null}
            <Button size="large" variant="tertiary" className={big} onClick={onDiscard}>
              {state.take.madeHere ? "Record again" : "Choose another"}
            </Button>
          </div>
        </>
      );
    case "sending": {
      const pct = state.take.blob.size === 0 ? 0 : Math.min(100, Math.round((state.sent / state.take.blob.size) * 100));
      return (
        <>
          <TakeCard take={state.take} />
          <div className="mt-6">
            <div
              role="progressbar"
              aria-label="Sending the recording"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1.5 overflow-hidden rounded-full bg-background-tertiary"
            >
              <div className="h-full rounded-full bg-content-primary transition-[width] duration-200 ease-out" style={{ width: `${Math.max(pct, 2)}%` }} />
            </div>
            <p className="mt-1.5 text-paragraph-small text-content-tertiary tabular-nums">
              Sending, {formatSize(state.sent)} of {formatSize(state.take.blob.size)}
            </p>
          </div>
        </>
      );
    }
    case "sent":
      return <p className="mt-6 text-paragraph-medium text-content-secondary">Sent. Opening the transcript…</p>;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function TakeCard({ take }: { take: Take }) {
  return (
    <div className="mt-6 rounded-control border border-border-opaque bg-background-secondary p-3 sm:p-4">
      <p className="flex min-w-0 items-center gap-2 text-label-small text-content-primary">
        <FileAudioIcon className="size-5 shrink-0 text-content-tertiary" />
        <span className="truncate font-mono">{take.name}</span>
        <span className="ml-auto shrink-0 text-paragraph-xsmall text-content-tertiary tabular-nums">{formatSize(take.blob.size)}</span>
      </p>
      {/* Listening back before sending catches a recording made with the mic muted. */}
      <audio controls src={take.url} className="mt-3 h-11 w-full" aria-label="Play back the recording" />
    </div>
  );
}

function FileOption({ onPick }: { onPick: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2">
      <input
        ref={input}
        type="file"
        accept="audio/*,.m4a,.mp3,.wav,.weba,.ogg,.opus,.aac,.flac"
        className="hidden"
        aria-label="Choose a recording"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file !== undefined) onPick(file);
          e.target.value = "";
        }}
      />
      <p className="text-paragraph-small text-content-tertiary">Have a voice memo already?</p>
      <Button variant="secondary" size="compact" onClick={() => input.current?.click()}>
        Use a recording
      </Button>
    </div>
  );
}

