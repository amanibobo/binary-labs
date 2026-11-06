"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { FileHit } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { formatSize, openInDropboxUrl } from "@/lib/format";
import type { ProtocolId, Sha256 } from "@/lib/ids";
import type { SendResult } from "@/lib/upload-queue";
import { localDay } from "@/lib/uploads";
import {
  bytesSent,
  nextStep,
  nextToSend,
  NO_UPLOADS,
  unsent,
  uploadsReducer,
  type StepDone,
  type UploadsAction,
  type VideoUpload,
} from "@/lib/video-upload-state";
import { talkThroughHref } from "@/lib/talk-throughs";
import { isSettled, recordedName, VIDEO_TYPES, VideoType, type ProtocolVideo, type ReadyVideo } from "@/lib/videos";
import { DeleteIcon } from "../icons/base-web";
import { CameraIcon, FileVideoIcon, LinkIcon, OpenExternalIcon, UploadIcon } from "../icons/drawn";
import { useLabApi, type LabApi } from "../lab-api";
import { FilePicker } from "../protocols/file-picker";
import { Button, buttonVariants } from "../ui/button";
import { Dialog, DialogContent } from "../ui/dialog";

const POLL_MS = 3_000;

export const videosKey = (protocolId: ProtocolId) => ["protocol-videos", protocolId] as const;

// A page's procedure videos: the ones that play, the ones on their way up from this browser,
// and the ones the worker is still checking. Videos are protocol files whose blob is a video;
// the Files list below leaves them out.
export function ProtocolVideos({
  protocolId,
  initial,
  editable,
}: {
  protocolId: ProtocolId;
  initial: ProtocolVideo[];
  editable: boolean;
}) {
  const api = useLabApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [uploads, dispatch] = useReducer(uploadsReducer, NO_UPLOADS);
  const query = useQuery({
    queryKey: videosKey(protocolId),
    queryFn: ({ signal }) => api.protocolVideos(protocolId, signal),
    initialData: initial,
    refetchInterval: (q) => (q.state.data?.every(isSettled) === false ? POLL_MS : false),
  });
  const videos = query.data;
  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: videosKey(protocolId) }),
    [queryClient, protocolId],
  );

  const driver = useUploadDriver({ api, protocolId, uploads: uploads.items, dispatch, onAdded: refresh });

  useEffect(() => {
    if (unsent(uploads) === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploads]);

  function add(file: File, recorded: boolean) {
    setAdding(false);
    const type = VideoType.safeParse(file.type);
    const name = recorded && type.success ? recordedName(new Date(), type.data) : file.name;
    dispatch({ type: "add", file, name, modifiedAt: recorded ? null : file.lastModified || null });
  }

  async function link(hit: FileHit) {
    try {
      await api.linkProtocolFile(protocolId, hit.sha256);
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't link that video.");
    }
  }

  async function takeOff(video: ProtocolVideo) {
    try {
      if (video.state === "ready") await api.unlinkProtocolFile(protocolId, video.sha256);
      else await api.removePendingVideo(protocolId, video.locationId);
      refresh();
      toast(`Took ${video.name} off this page`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't take that video off.");
    }
  }

  // Steps are drafted from what's said in the video, against the page as it is now; the draft
  // opens on its own page, which waits for the transcript if it isn't in yet.
  async function draftSteps(sha: Sha256) {
    try {
      router.push(talkThroughHref(await api.draftStepsFromVideo(protocolId, sha)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't start drafting steps.");
    }
  }

  function cancel(upload: VideoUpload) {
    driver.cancel(upload.id);
    if (upload.session !== null) void api.abortVideoUpload(upload.session);
    dispatch({ type: "remove", id: upload.id });
  }

  const showing = uploads.items.filter((u) => u.phase.kind !== "added");
  const linked = new Set(videos.flatMap((v) => (v.state === "ready" ? [v.sha256] : [])));
  if (!editable && videos.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="mt-14">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 id={headingId} className="text-heading-xsmall">
          Videos
        </h2>
        {editable ? (
          <Button variant="secondary" size="compact" onClick={() => setAdding(true)}>
            <FileVideoIcon className="size-5" />
            Add a video
          </Button>
        ) : null}
      </div>
      {videos.length === 0 && showing.length === 0 ? (
        <p className="text-paragraph-medium text-content-tertiary">
          No videos yet. Add one of the technique so anyone learning it can watch.
        </p>
      ) : (
        <ul className="grid gap-10">
          {videos.map((video) => (
            <li key={video.locationId}>
              <VideoItem
                video={video}
                onTakeOff={editable ? () => void takeOff(video) : null}
                onDraftSteps={editable && video.state === "ready" && video.transcript.kind !== "unavailable" ? () => void draftSteps(video.sha256) : null}
              />
            </li>
          ))}
          {showing.map((upload) => (
            <li key={`upload-${upload.id}`}>
              <UploadItem
                upload={upload}
                onRetry={() => dispatch({ type: "retry", id: upload.id })}
                onCancel={() => cancel(upload)}
              />
            </li>
          ))}
        </ul>
      )}
      <AddVideoDialog
        open={adding}
        onOpenChange={setAdding}
        onFile={add}
        onPickFromLab={() => {
          setAdding(false);
          setPicking(true);
        }}
      />
      <FilePicker
        open={picking}
        onOpenChange={setPicking}
        linked={linked}
        onLink={(hit) => void link(hit)}
        title="Link a video"
        kind="video"
      />
    </section>
  );
}

// Takes one step at a time for the first upload that's ready, and wakes a waiting one when its
// delay is up or the browser comes back online.
function useUploadDriver({
  api,
  protocolId,
  uploads,
  dispatch,
  onAdded,
}: {
  api: LabApi;
  protocolId: ProtocolId;
  uploads: VideoUpload[];
  dispatch: (action: UploadsAction) => void;
  onAdded: () => void;
}): { cancel: (id: number) => void } {
  // The request in flight for each upload. It also keeps one request per step when React runs
  // this effect twice for the same state.
  const inFlight = useRef(new Map<number, AbortController>());
  const cancelled = useRef(new Set<number>());
  const next = nextToSend({ nextId: 0, items: uploads });

  useEffect(() => {
    if (next === null || inFlight.current.has(next.id)) return;
    const upload = next;
    const controller = new AbortController();
    inFlight.current.set(upload.id, controller);
    dispatch({ type: "begin", id: upload.id });
    void takeStep(api, protocolId, upload, (sent) => dispatch({ type: "progress", id: upload.id, sent }), controller.signal).then(
      (result) => {
        inFlight.current.delete(upload.id);
        // Cancelled while its session was opening: close the session nobody will use.
        if (cancelled.current.has(upload.id) && result.kind === "stored" && result.receipt.step === "start") {
          void api.abortVideoUpload(result.receipt.session);
        }
        dispatch({ type: "finish", id: upload.id, result, now: Date.now() });
        if (result.kind === "stored" && result.receipt.step === "complete") onAdded();
      },
    );
  }, [api, protocolId, next, dispatch, onAdded]);

  useEffect(() => {
    const timers = uploads.flatMap((u) =>
      u.phase.kind === "waiting" ? [setTimeout(() => dispatch({ type: "retry", id: u.id }), Math.max(0, u.phase.retryAt - Date.now()))] : [],
    );
    return () => timers.forEach(clearTimeout);
  }, [uploads, dispatch]);

  useEffect(() => {
    const online = () => dispatch({ type: "online" });
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [dispatch]);

  return {
    cancel: (id) => {
      cancelled.current.add(id);
      inFlight.current.get(id)?.abort();
    },
  };
}

async function takeStep(
  api: LabApi,
  protocolId: ProtocolId,
  upload: VideoUpload,
  onProgress: (sent: number) => void,
  signal: AbortSignal,
): Promise<SendResult<StepDone>> {
  const step = nextStep(upload);
  const type = VideoType.safeParse(upload.file.type);
  if (!type.success) return { kind: "refused", message: "That isn't a video we can play here." };
  const request = { protocolId, name: upload.name, size: upload.file.size, type: type.data };
  switch (step.kind) {
    case "start": {
      const result = await api.startVideoUpload(request);
      return result.kind === "stored" ? { kind: "stored", receipt: { step: "start", session: result.receipt } } : result;
    }
    case "part": {
      if (upload.session === null) return { kind: "interrupted", message: "The upload lost its place." };
      const bytes = upload.file.slice(step.start, step.end);
      const result = await api.sendVideoPart(upload.session, { partNumber: step.partNumber, bytes, fileSize: upload.file.size }, onProgress, signal);
      return result.kind === "stored" ? { kind: "stored", receipt: { step: "part", part: result.receipt } } : result;
    }
    case "complete": {
      if (upload.session === null) return { kind: "interrupted", message: "The upload lost its place." };
      const result = await api.completeVideoUpload(upload.session, {
        ...request,
        parts: upload.parts,
        uploadedOn: localDay(new Date()),
        modifiedAt: upload.modifiedAt,
      });
      return result.kind === "stored" ? { kind: "stored", receipt: { step: "complete", receipt: result.receipt } } : result;
    }
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

function AddVideoDialog({
  open,
  onOpenChange,
  onFile,
  onPickFromLab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFile: (file: File, recorded: boolean) => void;
  onPickFromLab: () => void;
}) {
  const pick = (recorded: boolean) => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file !== undefined) onFile(file, recorded);
  };
  const accept = [...VIDEO_TYPES, ".mp4", ".mov", ".m4v", ".webm"].join(",");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a video" aria-describedby={undefined}>
        <div className="grid gap-1 px-2 pt-3 pb-4 sm:px-3 sm:pb-6">
          {/* capture opens the camera on a phone; a desktop browser ignores it, so it's hidden there. */}
          <OptionLabel className="hidden pointer-coarse:flex" icon={<CameraIcon className="size-6" />} title="Record a video" line="Opens your camera. Hold the phone sideways.">
            <input type="file" accept="video/*" capture="environment" className="sr-only" onChange={pick(true)} />
          </OptionLabel>
          <OptionLabel icon={<UploadIcon className="size-6" />} title="Choose a video" line="MP4, MOV or WebM, up to 500 MB.">
            <input type="file" accept={accept} className="sr-only" onChange={pick(false)} />
          </OptionLabel>
          <button type="button" onClick={onPickFromLab} className={optionClass}>
            <span className="mt-0.5 text-content-secondary">
              <LinkIcon className="size-6" />
            </span>
            <span className="min-w-0 text-left">
              <span className="block text-label-medium text-content-primary">Link one from the lab&apos;s files</span>
              <span className="mt-0.5 block text-paragraph-small text-content-tertiary">A video already in Dropbox plays from there.</span>
            </span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const optionClass =
  "flex w-full cursor-pointer items-start gap-4 rounded-control px-3 py-3 transition-colors duration-150 ease-out hover:bg-background-secondary focus-within:outline-2 focus-within:outline-offset-[-2px] focus-within:outline-border-focus";

function OptionLabel({
  icon,
  title,
  line,
  className,
  children,
}: {
  icon: ReactNode;
  title: string;
  line: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn(optionClass, className)}>
      <span className="mt-0.5 text-content-secondary">{icon}</span>
      <span className="min-w-0">
        <span className="block text-label-medium text-content-primary">{title}</span>
        <span className="mt-0.5 block text-paragraph-small text-content-tertiary">{line}</span>
      </span>
      {children}
    </label>
  );
}

const frame = "aspect-video w-full overflow-hidden rounded-card bg-[#0b0d0e]";

function VideoItem({ video, onTakeOff, onDraftSteps }: { video: ProtocolVideo; onTakeOff: (() => void) | null; onDraftSteps: (() => void) | null }) {
  switch (video.state) {
    case "ready":
      return <ReadyVideoItem video={video} onTakeOff={onTakeOff} onDraftSteps={onDraftSteps} />;
    case "preparing":
      return (
        <div>
          <div aria-hidden className={cn(frame, "animate-pulse bg-background-secondary motion-reduce:animate-none")} />
          <Caption name={video.name} onTakeOff={onTakeOff}>
            Getting it ready to play. This takes a few seconds.
          </Caption>
        </div>
      );
    case "failed":
      return (
        <div>
          <div aria-hidden className={cn(frame, "bg-background-secondary")} />
          <Caption name={video.name} onTakeOff={onTakeOff}>
            We couldn&apos;t read this video. Take it off and add it again. ({video.message})
          </Caption>
        </div>
      );
    default: {
      const _exhaustive: never = video;
      return _exhaustive;
    }
  }
}

function ReadyVideoItem({ video, onTakeOff, onDraftSteps }: { video: ReadyVideo; onTakeOff: (() => void) | null; onDraftSteps: (() => void) | null }) {
  const api = useLabApi();
  const sources = api.videoSources(video);
  const open = video.sourceKind === "dropbox" ? { href: openInDropboxUrl(video.path), label: "Open in Dropbox" } : null;
  return (
    <div>
      {/* preload=metadata fetches only the start of the file; the rest comes in ranges as it plays. */}
      <video
        controls
        playsInline
        preload="metadata"
        poster={sources.poster ?? undefined}
        className={frame}
        aria-label={video.name}
        // No type hint: Chrome says it can't play video/quicktime, yet plays most phone MOVs.
        src={sources.src}
      />
      <Caption
        name={video.name}
        onTakeOff={onTakeOff}
        open={open}
        size={video.size}
      >
        <TranscriptLine sha256={video.sha256} transcript={video.transcript} />
        {onDraftSteps === null ? null : (
          <span className="mt-1 block">
            <button type="button" onClick={onDraftSteps} className="text-content-accent underline-offset-2 hover:underline">
              Draft steps from this video
            </button>
          </span>
        )}
      </Caption>
    </div>
  );
}

function TranscriptLine({ sha256, transcript }: { sha256: Sha256; transcript: ReadyVideo["transcript"] }) {
  const api = useLabApi();
  const queryClient = useQueryClient();
  const [shown, setShown] = useState(false);
  const panelId = useId();
  switch (transcript.kind) {
    case "waiting":
      return <>Listening to it, so search can find what&apos;s said.</>;
    case "ready":
      if (transcript.text.trim() === "") return <>We didn&apos;t hear any speech in it.</>;
      return (
        <>
          Search finds what&apos;s said in it.{" "}
          <button
            type="button"
            aria-expanded={shown}
            aria-controls={panelId}
            onClick={() => setShown((s) => !s)}
            className="text-content-accent underline-offset-2 hover:underline"
          >
            {shown ? "Hide transcript" : "Show transcript"}
          </button>
          {shown ? (
            <span id={panelId} className="mt-3 block max-w-prose text-paragraph-medium whitespace-pre-line text-content-secondary">
              {transcript.text}
            </span>
          ) : null}
        </>
      );
    case "failed":
      return (
        <>
          {transcript.message}{" "}
          <button
            type="button"
            className="text-content-accent underline-offset-2 hover:underline"
            onClick={() =>
              void api
                .retryVideoTranscript(sha256)
                .then(() => queryClient.invalidateQueries({ queryKey: ["protocol-videos"] }))
                .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "We couldn't try again."))
            }
          >
            Try again
          </button>
        </>
      );
    case "unavailable":
      return <>{transcript.message}</>;
    default: {
      const _exhaustive: never = transcript;
      return _exhaustive;
    }
  }
}

function Caption({
  name,
  size,
  open,
  onTakeOff,
  children,
}: {
  name: string;
  size?: number;
  open?: { href: string; label: string } | null;
  onTakeOff: (() => void) | null;
  children: ReactNode;
}) {
  return (
    <div className="mt-3 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-label-medium text-content-primary">
          {name}
          {size === undefined ? null : <span className="ml-2 text-paragraph-small text-content-tertiary tabular-nums">{formatSize(size)}</span>}
        </p>
        <div className="mt-1 text-paragraph-small text-content-tertiary">{children}</div>
      </div>
      <span className="-mt-1.5 flex shrink-0">
        {open === null || open === undefined ? null : (
          <a href={open.href} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "tertiary", shape: "square" }), "text-content-secondary")}>
            <OpenExternalIcon />
            <span className="sr-only">
              {open.label}: {name} (opens in a new tab)
            </span>
          </a>
        )}
        {onTakeOff === null ? null : (
          <button type="button" onClick={onTakeOff} className={cn(buttonVariants({ variant: "tertiary", shape: "square" }), "text-content-secondary")}>
            <DeleteIcon />
            <span className="sr-only">Take {name} off this page</span>
          </button>
        )}
      </span>
    </div>
  );
}

function UploadItem({ upload, onRetry, onCancel }: { upload: VideoUpload; onRetry: () => void; onCancel: () => void }) {
  // Stable per file, so progress updates don't load the preview again.
  const preview = useMemo(() => showFile(upload.file), [upload.file]);
  const sent = bytesSent(upload);
  const total = upload.file.size;
  const pct = Math.min(100, Math.floor((sent / total) * 100));
  const step = nextStep(upload);
  const { phase } = upload;
  const checking = phase.kind === "busy" && step.kind === "complete";
  return (
    <div>
      <div className={cn(frame, "relative")}>
        <video ref={preview} muted playsInline preload="metadata" className="size-full object-contain opacity-60" aria-hidden />
      </div>
      <div className="mt-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-label-medium text-content-primary">
            {upload.name}
            <span className="ml-2 text-paragraph-small text-content-tertiary tabular-nums">{formatSize(total)}</span>
          </p>
          {phase.kind === "refused" ? (
            <p className="mt-1 text-paragraph-small text-content-secondary">{phase.message}</p>
          ) : (
            <>
              <div
                role="progressbar"
                aria-label={`Uploading ${upload.name}`}
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-background-tertiary"
              >
                <div className="h-full rounded-full bg-content-primary transition-[width] duration-200 ease-out" style={{ width: `${Math.max(pct, 2)}%` }} />
              </div>
              <p className="mt-1.5 text-paragraph-small text-content-tertiary tabular-nums" aria-live="polite">
                {uploadLine(upload, { sent, total, pct, checking })}
              </p>
            </>
          )}
        </div>
        <span className="-mt-1.5 flex shrink-0 gap-1">
          {phase.kind === "waiting" || phase.kind === "stopped" ? (
            <Button variant="secondary" size="compact" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
          {checking ? null : (
            <Button variant="tertiary" size="compact" onClick={onCancel}>
              {phase.kind === "refused" ? "Dismiss" : "Cancel"}
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}

function uploadLine(upload: VideoUpload, p: { sent: number; total: number; pct: number; checking: boolean }): string {
  const { phase } = upload;
  switch (phase.kind) {
    case "waiting":
      return `${phase.message} Trying again in a moment. ${formatSize(p.sent)} of ${formatSize(p.total)} is safe.`;
    case "stopped":
      return `${phase.message} ${formatSize(p.sent)} of ${formatSize(p.total)} is safe; Retry picks up from there.`;
    case "ready":
    case "busy":
      if (p.checking) return "Checking the video.";
      if (upload.session === null) return "Getting ready to upload.";
      return `Uploading, ${p.pct}% of ${formatSize(p.total)}. Keep this page open.`;
    case "refused":
    case "added":
      return "";
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

// Shows the file being uploaded straight from this device, released when the row goes.
function showFile(file: Blob) {
  return (video: HTMLVideoElement | null) => {
    if (video === null) return;
    const url = URL.createObjectURL(file);
    video.src = url;
    return () => URL.revokeObjectURL(url);
  };
}
