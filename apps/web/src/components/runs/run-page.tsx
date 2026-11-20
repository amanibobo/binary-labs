"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";
import { When } from "@/components/ui/when";
import { cn } from "@/lib/cn";
import { fileHistoryHref } from "@/lib/drive";
import { formatDay, formatSize } from "@/lib/format";
import type { RunId } from "@/lib/ids";
import {
  fileSaysLine,
  fileStateLine,
  ROLE_LABELS,
  RunFileRole,
  STATUS_CHOICES,
  statusLabel,
  type RunFile,
  type RunRecord,
  type RunRef,
  type RunStatus,
} from "@/lib/run-record";
import { KindIcon } from "../files/kind-icon";
import { OpenExternalIcon, PencilIcon } from "../icons/drawn";
import { FilePicker } from "../protocols/file-picker";
import { Breadcrumbs } from "../ui/breadcrumbs";
import { Button, buttonVariants } from "../ui/button";
import { dataRow, dataSurface } from "../ui/data-table";
import { DebriefSection } from "./debrief-section";
import { FailureSection } from "./failure-section";
import { OriginalsSection } from "./originals-section";
import { PlanSection } from "./plan-section";
import { runFileHref, runHref, useRunsApi } from "./runs-api";
import { RunSection } from "./section";
import { SharingSection } from "./sharing-section";

const quietAction =
  "-mx-1.5 inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-label-small text-content-primary transition-colors duration-150 ease-out hover:bg-background-tertiary disabled:text-content-tertiary disabled:hover:bg-transparent max-sm:min-h-11";
const textInput =
  "h-8 w-full rounded-md border border-border-opaque bg-background-primary px-2 text-paragraph-small text-content-primary max-sm:h-11 max-sm:text-paragraph-medium";

// One run: what was tried, when, by whom, how it went, the files it produced and the run it
// retries. Each write hands back the whole run, which replaces the one on screen.
export function RunView({ initial }: { initial: RunRecord }) {
  const api = useRunsApi();
  const [run, setRun] = useState(initial);
  const [busy, setBusy] = useState(false);

  // One write at a time; a failure says why in the database's own plain words.
  const write = async (action: () => Promise<RunRecord | null>) => {
    setBusy(true);
    try {
      const next = await action();
      if (next !== null) setRun(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const facts = [
    run.startedOn === null ? "No date yet" : run.endedOn === null || run.endedOn === run.startedOn ? formatDay(run.startedOn) : `${formatDay(run.startedOn)} to ${formatDay(run.endedOn)}`,
    run.person === null ? null : `Run by ${run.person.name}`,
    run.experiment?.name ?? null,
  ].filter((f): f is string => f !== null);
  const section = { run, onChange: setRun };
  const wentWrong = run.status === "failed" || run.status === "odd";

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 sm:px-8 sm:pt-10">
      <Breadcrumbs items={[{ label: "Runs", href: "/runs" }, { label: run.title, href: runHref(run.id) }]} />
      <Title run={run} disabled={busy} onRename={(title) => write(() => api.edit(run.id, { title }))} />
      <p className="mt-1 text-paragraph-small text-content-secondary">{facts.join(" · ")}</p>

      <Status run={run} disabled={busy} write={write} />
      {wentWrong ? <FailureSection {...section} /> : null}
      {wentWrong ? <DebriefSection {...section} /> : null}

      <Files run={run} disabled={busy} write={write} />
      <OriginalsSection {...section} />
      <PlanSection {...section} />

      <Retries run={run} disabled={busy} write={write} />
      <SharingSection {...section} />

      <p className="mt-10 text-paragraph-xsmall text-content-tertiary">
        Added <When iso={run.createdAt} />
      </p>
    </div>
  );
}

type Write = (action: () => Promise<RunRecord | null>) => Promise<void>;

function Title({ run, disabled, onRename }: { run: RunRecord; disabled: boolean; onRename: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(run.title);
  const inputId = useId();
  if (!editing) {
    return (
      <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="min-w-0 text-heading-medium break-words">{run.title}</h1>
        <button
          type="button"
          onClick={() => {
            setText(run.title);
            setEditing(true);
          }}
          className={quietAction}
        >
          <PencilIcon className="size-3.5" />
          Rename
        </button>
      </div>
    );
  }
  return (
    <form
      className="mt-4 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const next = text.trim();
        if (next !== "" && next !== run.title) onRename(next);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setEditing(false);
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Name of this run
      </label>
      <input id={inputId} autoFocus value={text} maxLength={200} onChange={(e) => setText(e.target.value)} className={cn(textInput, "max-w-md")} />
      <Button type="submit" size="compact" disabled={disabled || text.trim() === ""}>
        Save
      </Button>
      <Button type="button" variant="tertiary" size="compact" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </form>
  );
}

// How the run went, as three plain answers. Leaving failed or odd would remove a cause or a
// failure type someone wrote down, so that asks first.
function Status({ run, disabled, write }: { run: RunRecord; disabled: boolean; write: Write }) {
  const api = useRunsApi();
  const name = useId();
  // The answer waiting on "this removes the cause"; undefined when nothing is waiting.
  const [asking, setAsking] = useState<RunStatus | null | undefined>(undefined);
  const removed = removedWords(run);

  const choose = (status: RunStatus | null, clearCauses: boolean) =>
    write(async () => {
      const outcome = await api.setStatus(run.id, status, clearCauses);
      switch (outcome.kind) {
        case "saved":
          setAsking(undefined);
          return outcome.run;
        case "has_causes":
          setAsking(status);
          return null;
        default: {
          const _exhaustive: never = outcome;
          return _exhaustive;
        }
      }
    });

  return (
    <RunSection
      title="How did it go?"
      note={run.status !== null && run.statusBy === null ? "Binary read this from the first file's label when the run was made. Change it if it's wrong." : undefined}
    >
      <fieldset disabled={disabled} className="grid gap-1">
        <legend className="sr-only">How did it go?</legend>
        {STATUS_CHOICES.map((choice) => (
          <label key={choice.status} className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-background-secondary has-[:checked]:bg-background-secondary">
            <input
              type="radio"
              name={name}
              checked={run.status === choice.status}
              onChange={() => void choose(choice.status, false)}
              className="mt-1 size-4 shrink-0 accent-[var(--content-primary)]"
            />
            <span>
              <span className="block text-label-medium text-content-primary">{choice.label}</span>
              <span className="block text-paragraph-small text-content-secondary">{choice.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {run.status === null ? (
        <p className="mt-2 px-2 text-paragraph-small text-content-tertiary">Not marked yet. Pick one when you know.</p>
      ) : (
        <button type="button" disabled={disabled} onClick={() => void choose(null, false)} className={cn(quietAction, "mx-0.5 mt-1")}>
          Clear my answer
        </button>
      )}
      {asking === undefined ? null : (
        <div role="alertdialog" aria-label={`Remove ${removed.name}?`} className="mt-3 rounded-card border border-border-opaque bg-background-secondary px-4 py-3">
          <p className="max-w-prose text-paragraph-small text-content-primary">
            This run has {removed.has}. {asking === null ? "Clearing your answer" : `Marking it ${statusLabel(asking).toLowerCase()}`} removes {removed.it}. The
            run&rsquo;s history keeps what {removed.was}.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="negative" size="compact" disabled={disabled} onClick={() => void choose(asking, true)}>
              Remove {removed.name}
            </Button>
            <Button type="button" variant="secondary" size="compact" onClick={() => setAsking(undefined)}>
              Keep it as it is
            </Button>
          </div>
        </div>
      )}
    </RunSection>
  );
}

// What leaving failed or odd would remove, in the question's words.
const REMOVED = {
  cause: { name: "the cause", has: "a cause written down", it: "it", was: "it was" },
  type: { name: "the failure type", has: "a failure type picked", it: "it", was: "it was" },
  both: { name: "the cause and the failure type", has: "a cause and a failure type written down", it: "them", was: "they were" },
} as const;

function removedWords(run: RunRecord): (typeof REMOVED)[keyof typeof REMOVED] {
  const f = run.failure;
  const cause = f.suspectedCause !== null || f.confirmedCause !== null;
  if (!cause) return REMOVED.type;
  return f.taxonomyVersion === null ? REMOVED.cause : REMOVED.both;
}

function Files({ run, disabled, write }: { run: RunRecord; disabled: boolean; write: Write }) {
  const api = useRunsApi();
  const [picking, setPicking] = useState(false);
  const only = run.files.length === 1;
  return (
    <RunSection title="Files" note="What this run produced. Each opens exactly as Binary first read it, even if the file is edited or removed later.">
      <ul className={dataSurface}>
        {run.files.map((file) => (
          <FileRow key={file.sha256} run={run} file={file} disabled={disabled} only={only} write={write} />
        ))}
      </ul>
      <button type="button" disabled={disabled} onClick={() => setPicking(true)} className={cn(quietAction, "mx-0 mt-2")}>
        Add a file
      </button>
      <FilePicker
        open={picking}
        onOpenChange={setPicking}
        title="Add a file to this run"
        linked={new Set(run.files.map((f) => f.sha256))}
        onLink={(hit) => void write(() => api.addFiles(run.id, [hit.sha256], "evidence"))}
      />
    </RunSection>
  );
}

function FileRow({ run, file, disabled, only, write }: { run: RunRecord; file: RunFile; disabled: boolean; only: boolean; write: Write }) {
  const api = useRunsApi();
  const roleId = useId();
  const lines = [fileStateLine(file), fileSaysLine(file, run.status)].filter((l): l is string => l !== null);
  return (
    <li className={cn(dataRow, "flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3")}>
      <KindIcon kind={file.fileKind} className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-label-medium break-words text-content-primary">
          {file.locationId === null ? (
            file.name
          ) : (
            <Link href={fileHistoryHref(file.locationId)} className="underline-offset-4 hover:underline">
              {file.name}
            </Link>
          )}
        </p>
        <p className="text-paragraph-small text-content-tertiary">
          {file.originalName !== null && file.originalName !== file.name ? <span className="font-mono">{file.originalName} · </span> : null}
          {formatSize(file.size)}
        </p>
        {lines.map((line) => (
          <p key={line} className="text-paragraph-small text-content-secondary">
            {line}
          </p>
        ))}
        <label htmlFor={roleId} className="sr-only">
          What {file.name} is to this run
        </label>
        <select
          id={roleId}
          value={file.role}
          disabled={disabled}
          onChange={(e) => {
            const role = RunFileRole.parse(e.target.value);
            void write(() => api.addFiles(run.id, [file.sha256], role));
          }}
          className="mt-1.5 h-8 max-w-full rounded-md border border-border-opaque bg-background-primary px-1.5 text-paragraph-small text-content-primary max-sm:h-11"
        >
          {RunFileRole.options.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {file.kept ? (
          <a href={runFileHref(run.id, file.sha256)} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "compact" })}>
            <OpenExternalIcon className="size-5" />
            Open original
            <span className="sr-only"> of {file.name} (opens in a new tab)</span>
          </a>
        ) : null}
        <button
          type="button"
          disabled={disabled || only}
          title={only ? "A run keeps at least one file. Add another first." : undefined}
          onClick={() => void write(() => api.removeFile(run.id, file.sha256))}
          className={quietAction}
        >
          Take out<span className="sr-only"> {file.name}</span>
        </button>
      </div>
    </li>
  );
}

function RunLink({ run }: { run: RunRef }) {
  return (
    <>
      <Link href={runHref(run.id)} className="text-content-primary underline decoration-content-tertiary underline-offset-4 hover:decoration-content-primary">
        {run.title}
      </Link>
      <span className="text-content-tertiary">
        {" "}
        ({[run.startedOn === null ? null : formatDay(run.startedOn), statusLabel(run.status).toLowerCase()].filter((p) => p !== null).join(", ")})
      </span>
    </>
  );
}

// The earlier run this one tried again, and the later runs that tried this one again.
function Retries({ run, disabled, write }: { run: RunRecord; disabled: boolean; write: Write }) {
  const api = useRunsApi();
  const link = (retryOf: RunId | null) => write(() => api.linkRetry(run.id, retryOf));
  return (
    <RunSection title="Retries" note="If this run was a second try at an earlier one, link them so each shows the other.">
      <div className="grid gap-2 text-paragraph-small text-content-secondary">
        {run.retryOf === null ? null : (
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span>
              A retry of <RunLink run={run.retryOf} />
            </span>
            <button type="button" disabled={disabled} onClick={() => void link(null)} className={quietAction}>
              Unlink
            </button>
          </p>
        )}
        {run.retriedIn.length === 0 ? null : (
          <p>
            Tried again in{" "}
            {run.retriedIn.map((later, i) => (
              <span key={later.id}>
                {i > 0 ? ", " : null}
                <RunLink run={later} />
              </span>
            ))}
          </p>
        )}
        {run.retryHint === null ? null : (
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span>
              One of its files is marked as a repeat of a file in <RunLink run={run.retryHint} />. Is this run a retry of it?
            </span>
            <button type="button" disabled={disabled} onClick={() => void link(run.retryHint?.id ?? null)} className={quietAction}>
              Yes, link them
            </button>
          </p>
        )}
        <RetryPicker run={run} disabled={disabled} onPick={(id) => void link(id)} />
      </div>
    </RunSection>
  );
}

// Type to find the earlier run; the same experiment's runs on the nearest days come first.
function RetryPicker({ run, disabled, onPick }: { run: RunRecord; disabled: boolean; onPick: (id: RunId) => void }) {
  const api = useRunsApi();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputId = useId();
  const candidates = useQuery({
    queryKey: ["retry-candidates", run.id, query.trim()],
    queryFn: ({ signal }) => api.retryCandidates(run.id, query.trim(), signal),
    enabled: open,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });
  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} className={cn(quietAction, "justify-self-start")}>
        {run.retryOf === null ? "Pick the run this retries" : "Pick a different run"}
      </button>
    );
  }
  const runs = candidates.data ?? [];
  return (
    <div
      className="grid w-full max-w-md gap-1"
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Find the earlier run
      </label>
      <input id={inputId} autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find the earlier run by name" className={textInput} />
      <ul aria-label="Earlier runs" aria-busy={candidates.isFetching} className="grid">
        {runs.map((earlier) => (
          <li key={earlier.id}>
            <button
              type="button"
              onClick={() => {
                onPick(earlier.id);
                setOpen(false);
              }}
              className="flex min-h-8 w-full min-w-0 items-baseline gap-2 rounded-md px-2 text-left text-paragraph-small hover:bg-background-tertiary max-sm:min-h-11"
            >
              <span className="truncate text-content-primary">{earlier.title}</span>
              <span className="shrink-0 text-paragraph-xsmall text-content-tertiary">
                {[earlier.startedOn === null ? null : formatDay(earlier.startedOn), statusLabel(earlier.status)].filter((p) => p !== null).join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {candidates.isSuccess && runs.length === 0 ? <p className="px-2 text-paragraph-small text-content-tertiary">No other runs match.</p> : null}
      {candidates.isError ? <p className="px-2 text-paragraph-small text-content-primary">We couldn&apos;t list the runs. Try again.</p> : null}
      <button type="button" onClick={() => setOpen(false)} className={cn(quietAction, "mx-0.5 justify-self-start")}>
        Cancel
      </button>
    </div>
  );
}
