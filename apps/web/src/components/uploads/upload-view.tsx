"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { KindIcon } from "@/components/files/kind-icon";
import { useLabApi } from "@/components/lab-api";
import { CameraIcon, FileIcon, OpenExternalIcon, UploadIcon } from "@/components/icons/drawn";
import { buttonVariants } from "@/components/ui/button";
import { dataRow, dataSurface } from "@/components/ui/data-table";
import { Input, Label } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { needsCheck, type FileKind, type Label as FileLabel } from "@/lib/domain";
import { formatDate } from "@/lib/format";
import type { LocationId } from "@/lib/ids";
import { labelTags } from "@/lib/label-edit";
import { EMPTY_QUEUE, nextToSend, queueReducer, unsent, type NewItem, type QueueAction, type QueueItem } from "@/lib/upload-queue";
import { capturedName, isSettled, localDay, UPLOAD_MAX_BYTES, type UploadRow } from "@/lib/uploads";

const POLL_MS = 2_000;
const RECENT_CHIPS = 6;

// The day is the uploader's own, so it's read in the browser; the server renders without it.
const noSubscribe = () => () => {};
function useToday(): string | null {
  return useSyncExternalStore(noSubscribe, () => localDay(new Date()), () => null);
}

export function UploadView({ experiments, personName }: { experiments: string[]; personName: string | null }) {
  const api = useLabApi();
  const queryClient = useQueryClient();
  const [queue, dispatch] = useReducer(queueReducer, EMPTY_QUEUE);
  const [experiment, setExperiment] = useState(experiments[0] ?? "");
  const today = useToday();

  const add = (files: readonly File[], source: "camera" | "picker" | "paste") => {
    if (files.length === 0) return;
    const now = new Date();
    const items = files.map((file): NewItem => {
      const name =
        source === "camera" ? capturedName("photo", now, file.type) : source === "paste" ? capturedName("screenshot", now, file.type) : file.name;
      return {
        file,
        thumb: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
        meta: {
          name,
          experiment: experiment.trim() === "" ? null : experiment.trim(),
          uploadedOn: localDay(now),
          modifiedAt: source === "picker" && file.lastModified > 0 ? file.lastModified : null,
        },
      };
    });
    dispatch({ type: "add", items });
  };
  const addRef = useRef(add);
  useEffect(() => {
    addRef.current = add;
  });

  // One upload at a time; the next starts when this one settles. Requests outlive re-renders
  // and stop only when the page goes away.
  const inflight = useRef(new Map<number, AbortController>());
  const next = nextToSend(queue);
  useEffect(() => {
    if (next === null || inflight.current.has(next.id)) return;
    const controller = new AbortController();
    inflight.current.set(next.id, controller);
    dispatch({ type: "start", id: next.id });
    void api
      .uploadFile(next.file, next.meta, (sent) => dispatch({ type: "progress", id: next.id, sent }), controller.signal)
      .then((result) => {
        inflight.current.delete(next.id);
        dispatch({ type: "finish", id: next.id, result, now: Date.now() });
        if (result.kind === "stored") void queryClient.invalidateQueries({ queryKey: ["my-uploads"] });
      });
  }, [api, next, queryClient]);
  useEffect(() => {
    const requests = inflight.current;
    return () => requests.forEach((c) => c.abort());
  }, []);

  const waitingKey = queue.items.map((i) => (i.state.kind === "waiting" ? `${i.id}@${i.state.retryAt}` : "")).join(",");
  useEffect(() => {
    const timers = queue.items.flatMap((item) =>
      item.state.kind === "waiting"
        ? [setTimeout(() => dispatch({ type: "retry", id: item.id }), Math.max(0, item.state.retryAt - Date.now()))]
        : [],
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey]);

  useEffect(() => {
    const online = () => dispatch({ type: "online" });
    const paste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      addRef.current(files, "paste");
    };
    window.addEventListener("online", online);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("paste", paste);
    };
  }, []);

  const pending = unsent(queue);
  useEffect(() => {
    if (pending === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const thumbs = useRef<string[]>([]);
  useEffect(() => {
    thumbs.current = queue.items.flatMap((i) => (i.thumb === null ? [] : [i.thumb]));
  }, [queue.items]);
  useEffect(() => () => thumbs.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const storedIds = new Set(queue.items.flatMap((i) => (i.state.kind === "stored" ? [i.state.locationId] : [])));
  const uploads = useQuery({
    queryKey: ["my-uploads"],
    queryFn: ({ signal }) => api.myUploads(signal),
    refetchInterval: (q) => {
      const rows = q.state.data ?? [];
      const seen = new Set(rows.map((r) => r.locationId));
      const waiting = rows.some((r) => !isSettled(r.progress)) || [...storedIds].some((id) => !seen.has(id));
      return waiting ? POLL_MS : false;
    },
  });
  const rows = new Map((uploads.data ?? []).map((r) => [r.locationId, r]));
  const earlier = (uploads.data ?? []).filter((r) => !storedIds.has(r.locationId));
  const fresh = [...queue.items].reverse();

  return (
    <div
      className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 sm:px-8 sm:pt-12"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        add([...e.dataTransfer.files], "picker");
      }}
    >
      <h1 className="text-heading-medium sm:text-heading-large">Upload</h1>
      <p className="mt-1 text-paragraph-medium text-content-tertiary">
        {today === null ? "Dated today" : `Dated ${formatDate(`${today}T00:00:00Z`)}`}
        {personName === null ? " and filed under your name." : ` and filed under ${personName}.`}
      </p>

      <ExperimentPicker experiments={experiments} value={experiment} onChange={setExperiment} />
      <Pickers onFiles={add} />

      <section aria-labelledby="uploads-heading" className="mt-10">
        <h2 id="uploads-heading" className="text-label-large text-content-primary">
          {fresh.length > 0 ? "Uploads" : "Your recent uploads"}
        </h2>
        {fresh.length === 0 && earlier.length === 0 ? (
          uploads.isPending ? (
            <Skeleton className="mt-4 h-20" />
          ) : (
            <p className="mt-2 text-paragraph-medium text-content-tertiary">Nothing yet. Files you send show up here as they&apos;re read and labeled.</p>
          )
        ) : (
          <ul className={cn(dataSurface, "mt-4")}>
            <AnimatePresence initial={false}>
              {fresh.map((item) => (
                <Row key={`q${item.id}`}>
                  <QueuedUpload item={item} row={item.state.kind === "stored" ? rows.get(item.state.locationId) : undefined} dispatch={dispatch} />
                </Row>
              ))}
              {earlier.map((row) => (
                <Row key={row.locationId}>
                  <StoredUpload row={row} thumb={null} duplicate={false} />
                </Row>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <motion.li initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className={cn(dataRow, "overflow-hidden")}>
      {children}
    </motion.li>
  );
}

function ExperimentPicker({ experiments, value, onChange }: { experiments: string[]; value: string; onChange: (v: string) => void }) {
  const id = useId();
  const recent = experiments.slice(0, RECENT_CHIPS);
  // A tapped chip is the choice; the field holds only an experiment typed by hand.
  const picked = recent.find((name) => name.toLowerCase() === value.trim().toLowerCase()) ?? null;
  return (
    <div className="mt-6">
      <Label htmlFor={id} id={`${id}-label`}>
        Experiment
      </Label>
      {recent.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2" role="group" aria-labelledby={`${id}-label`}>
          {recent.map((name) => {
            const on = name === picked;
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? "" : name)}
                className={cn(
                  "min-h-11 max-w-full truncate rounded-full px-4 text-label-medium ring-1 transition-colors duration-150 ease-out ring-inset",
                  on
                    ? "bg-button-primary-fill text-content-inverse-primary ring-transparent"
                    : "bg-background-secondary text-content-primary ring-border-opaque hover:bg-button-secondary-hover",
                )}
              >
                {name}
              </button>
            );
          })}
        </div>
      ) : null}
      <Input
        id={id}
        list={`${id}-all`}
        value={picked === null ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={recent.length > 0 ? "Or type another experiment" : "Which experiment is this for?"}
        autoComplete="off"
        enterKeyHint="done"
        className="mt-3"
      />
      <datalist id={`${id}-all`}>
        {experiments.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </div>
  );
}

function Pickers({ onFiles }: { onFiles: (files: readonly File[], source: "camera" | "picker") => void }) {
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const take = (source: "camera" | "picker") => (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiles([...(e.target.files ?? [])], source);
    e.target.value = "";
  };
  return (
    <div className="mt-6">
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Take a photo" onChange={take("camera")} />
      <input ref={picker} type="file" multiple className="hidden" aria-label="Choose files" onChange={take("picker")} />
      <div className="grid gap-3 md:hidden">
        <button type="button" onClick={() => camera.current?.click()} className={cn(buttonVariants({ size: "large" }), "min-h-14 w-full")}>
          <CameraIcon />
          Take a photo
        </button>
        <button type="button" onClick={() => picker.current?.click()} className={cn(buttonVariants({ variant: "secondary", size: "large" }), "min-h-14 w-full")}>
          <UploadIcon />
          Choose files
        </button>
      </div>
      <div className="flex flex-col items-center rounded-card border border-dashed border-border-raised bg-background-secondary px-6 py-10 text-center max-md:hidden">
        <UploadIcon className="size-8 text-content-tertiary" />
        <p className="mt-3 text-label-large text-content-primary">Drop files here or paste a screenshot</p>
        <p className="mt-1 text-paragraph-small text-content-tertiary">
          Photos, screenshots and documents up to {UPLOAD_MAX_BYTES / 1024 / 1024} MB. Videos come later.
        </p>
        <button type="button" onClick={() => picker.current?.click()} className={cn(buttonVariants({ variant: "secondary" }), "mt-5")}>
          Choose files
        </button>
      </div>
      <p className="mt-3 text-paragraph-small text-content-tertiary md:hidden">
        Photos, screenshots and documents up to {UPLOAD_MAX_BYTES / 1024 / 1024} MB.
      </p>
    </div>
  );
}

function Thumb({ src, kind }: { src: string | null; kind: FileKind | null }) {
  return (
    <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border-opaque bg-background-secondary">
      {src !== null ? (
        // eslint-disable-next-line @next/next/no-img-element -- object URLs and short-lived preview redirects
        <img src={src} alt="" className="size-full object-cover" />
      ) : kind !== null ? (
        <KindIcon kind={kind} />
      ) : (
        <FileIcon className="text-content-tertiary" />
      )}
    </span>
  );
}

const rowShell = "flex items-start gap-3 px-4 py-3 sm:gap-4 sm:px-5";
const smallAction = cn(buttonVariants({ variant: "secondary", size: "compact" }), "shrink-0");

function QueuedUpload({ item, row, dispatch }: { item: QueueItem; row: UploadRow | undefined; dispatch: (action: QueueAction) => void }) {
  const { state } = item;
  if (state.kind === "stored") {
    if (row !== undefined) return <StoredUpload row={row} thumb={item.thumb} duplicate={state.duplicate} />;
    return (
      <div className={rowShell}>
        <Thumb src={item.thumb} kind={null} />
        <ReadingLines name={item.meta.name} />
      </div>
    );
  }
  const pct = item.file.size === 0 ? 0 : Math.min(100, Math.round(((state.kind === "sending" ? state.sent : 0) / item.file.size) * 100));
  return (
    <div className={rowShell}>
      <Thumb src={item.thumb} kind={null} />
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="truncate font-mono text-label-medium text-content-primary">{item.meta.name}</p>
        {state.kind === "sending" ? (
          <div className="mt-2">
            <div
              role="progressbar"
              aria-label={`Uploading ${item.meta.name}`}
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1.5 overflow-hidden rounded-full bg-background-tertiary"
            >
              <div className="h-full rounded-full bg-content-primary transition-[width] duration-200 ease-out" style={{ width: `${Math.max(pct, 2)}%` }} />
            </div>
            <p className="mt-1.5 text-paragraph-small text-content-tertiary tabular-nums">Uploading, {pct}%</p>
          </div>
        ) : (
          <p className="mt-1 text-paragraph-small text-content-tertiary">
            {state.kind === "queued"
              ? item.failures > 0
                ? "Trying again"
                : "Waiting to upload"
              : state.kind === "waiting"
                ? `${state.message} Trying again in a moment.`
                : state.kind === "stopped"
                  ? `${state.message} Still on this page; tap Retry when you have signal.`
                  : state.message}
          </p>
        )}
      </div>
      {state.kind === "waiting" || state.kind === "stopped" ? (
        <button type="button" className={smallAction} onClick={() => dispatch({ type: "retry", id: item.id })}>
          Retry
        </button>
      ) : state.kind === "refused" ? (
        <button type="button" className={smallAction} onClick={() => dispatch({ type: "remove", id: item.id })}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

function ReadingLines({ name }: { name: string }) {
  return (
    <div className="min-w-0 flex-1 pt-0.5">
      <p className="truncate font-mono text-label-medium text-content-primary">{name}</p>
      <span className="sr-only">Uploaded. Reading the file.</span>
      <Skeleton className="mt-2 h-4 w-40 max-w-full" />
    </div>
  );
}

const dayFormat = (iso: string) => formatDate(`${iso}T00:00:00Z`);
const tag = "inline-flex h-6 max-w-full items-center rounded-md px-2 text-label-xsmall";

function StoredUpload({ row, thumb, duplicate }: { row: UploadRow; thumb: string | null; duplicate: boolean }) {
  const api = useLabApi();
  const { progress } = row;
  const src = "hasPreview" in progress && progress.hasPreview ? api.previewUrl(progress.sha256, { view: false }) : thumb;
  const kind = "fileKind" in progress ? progress.fileKind : null;
  return (
    <div className={rowShell}>
      <Thumb src={src} kind={kind} />
      {progress.kind === "reading" ? (
        <ReadingLines name={row.name} />
      ) : (
        <div className="min-w-0 flex-1 pt-0.5">
          <Title row={row} label={progress.kind === "labeled" ? progress.label : null} />
          {progress.kind === "labeling" ? (
            <>
              <span className="sr-only">Labeling.</span>
              <Skeleton className="mt-2 h-5 w-56 max-w-full" />
            </>
          ) : progress.kind === "labeled" ? (
            <Tags label={progress.label} />
          ) : (
            <p className="mt-1 text-paragraph-small text-content-tertiary">We couldn&apos;t read this file. It&apos;s kept, and you can still open it.</p>
          )}
          {duplicate ? <p className="mt-1 text-paragraph-small text-content-tertiary">Already in the lab, so it wasn&apos;t stored twice.</p> : null}
        </div>
      )}
      <OpenLink locationId={row.locationId} name={row.name} />
    </div>
  );
}

function Title({ row, label }: { row: UploadRow; label: FileLabel | null }) {
  const named = label?.cleanName ?? null;
  return (
    <>
      <p className={cn("truncate text-label-medium text-content-primary", named === null && "font-mono")}>{named ?? row.name}</p>
      {named !== null ? <p className="truncate font-mono text-paragraph-xsmall text-content-tertiary">{row.name}</p> : null}
    </>
  );
}

function Tags({ label }: { label: FileLabel }) {
  if (label.status === "needs_look") {
    return <p className="mt-1 text-paragraph-small text-content-tertiary">Needs a look: say what it is from Needs a look.</p>;
  }
  return (
    <p className="mt-2 flex flex-wrap gap-1.5">
      {needsCheck(label) ? <span className={cn(tag, "bg-background-warning text-content-warning")}>Check this</span> : null}
      {labelTags(label, dayFormat).map((t) => (
        <span key={t.key} className={cn(tag, "bg-background-tertiary text-content-secondary")}>
          <span className="truncate">{t.text}</span>
        </span>
      ))}
    </p>
  );
}

function OpenLink({ locationId, name }: { locationId: LocationId; name: string }) {
  return (
    <a
      href={`/api/files/${locationId}`}
      target="_blank"
      rel="noreferrer"
      className={cn(buttonVariants({ variant: "tertiary", shape: "square" }), "-mr-2 shrink-0 text-content-secondary")}
    >
      <OpenExternalIcon />
      <span className="sr-only">Open {name} (opens in a new tab)</span>
    </a>
  );
}
