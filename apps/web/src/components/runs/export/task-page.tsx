"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { When } from "@/components/ui/when";
import { cn } from "@/lib/cn";
import { formatSize } from "@/lib/format";
import type { PersonId } from "@/lib/ids";
import type { RunRecord } from "@/lib/run-record";
import {
  EXCLUDABLE_FIELDS,
  exclusionLabel,
  LEFT_OUT_LINES,
  MAX_CRITERIA,
  REASON_LINES,
  SaveTaskRequest,
  taskDownloadHref,
  type BuiltFolder,
  type ExportReason,
  type PersonChoice,
  type RunTask,
  type TaskPreview,
} from "@/lib/task-export";
import { Breadcrumbs } from "../../ui/breadcrumbs";
import { Button, buttonVariants } from "../../ui/button";
import { inputVariants, Textarea } from "../../ui/field";
import { runFileHref, runHref } from "../runs-api";
import { RunSection } from "../section";
import { useExportApi } from "./export-api";

const message = (error: unknown) => (error instanceof Error ? error.message : "We couldn't do that. Try again.");
const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

// One run on its way to becoming a task: what is still needed, the question and rubric a
// second scientist writes, the record with the names taken out, and the folder.
export function TaskView({ run, initial, people, me }: { run: RunRecord; initial: RunTask; people: readonly PersonChoice[]; me: PersonId | null }) {
  const api = useExportApi();
  const [task, setTask] = useState(initial);
  const [preview, setPreview] = useState<TaskPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const showPreview = async () => {
    setLoadingPreview(true);
    try {
      setPreview(await api.preview(run.id, new AbortController().signal));
    } catch (error) {
      toast.error(message(error));
    } finally {
      setLoadingPreview(false);
    }
  };
  // What was checked is no longer what would be built.
  const changed = (next: RunTask) => {
    setTask(next);
    setPreview(null);
  };
  const reasons = [...task.blocks, ...task.gaps];
  const causeReady = !task.gaps.includes("no_confirmed_cause") && !task.blocks.includes("not_attested");

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 sm:px-8 sm:pt-10">
      <Breadcrumbs
        items={[
          { label: "Runs", href: "/runs" },
          { label: run.title, href: runHref(run.id) },
          { label: "Task", href: `${runHref(run.id)}/export` },
        ]}
      />
      <h1 className="mt-4 text-heading-medium break-words">Make a task from this run</h1>
      <p className="mt-1 max-w-prose text-paragraph-small text-content-secondary">
        A task is this run with the names taken out: its files, what was done, a question, and the confirmed cause as the answer. Nothing leaves the lab until
        someone downloads the folder.
      </p>
      {task.demo ? <p className="mt-3 max-w-prose text-paragraph-small text-content-primary">SAMPLE. This is a demo lab and its data is made up, so no folder can be built from it.</p> : null}

      <RunSection title="What's still needed">
        {reasons.length === 0 ? (
          <p className="text-paragraph-small text-content-secondary">Nothing. This run can become a task.</p>
        ) : (
          <ul className="grid max-w-prose list-disc gap-1.5 pl-5 text-paragraph-small text-content-primary">
            {reasons.map((reason) => (
              <li key={reason}>{REASON_LINES[reason]}</li>
            ))}
          </ul>
        )}
      </RunSection>

      <RunSection title="The question and the rubric" note="Written by a second scientist: someone other than the person who ran this. The answer is the confirmed cause below.">
        <Cause run={run} />
        {causeReady ? (
          <TaskForm run={run} task={task} people={people.filter((p) => p.id !== task.ranBy)} me={me} onSaved={changed} />
        ) : (
          <p className="mt-3 max-w-prose text-paragraph-small text-content-tertiary">You can write these once the cause is confirmed and the person who confirmed it has said so.</p>
        )}
      </RunSection>

      <RunSection title="Check what leaves the lab" note="Binary replaces the names it knows: the lab's people, their emails, and sample IDs made from someone's name. Read it through. A name Binary has never seen won't be caught.">
        <Button type="button" variant="secondary" size="compact" disabled={loadingPreview} onClick={() => void showPreview()}>
          {loadingPreview ? "Loading" : preview === null ? "Show the record with names taken out" : "Load it again"}
        </Button>
        {preview === null ? null : <Preview run={run} preview={preview} />}
        <Exclusions run={run} task={task} onChanged={(exclusions) => changed({ ...task, exclusions })} />
      </RunSection>

      <RunSection title="Build the folder">
        <Build run={run} task={task} checked={preview !== null} blocked={reasons} onBuilt={setTask} />
        <Folders run={run} folders={task.exports} />
      </RunSection>
    </div>
  );
}

function Cause({ run }: { run: RunRecord }) {
  const { confirmedCause, confirmedBy } = run.failure;
  if (confirmedCause === null) return null;
  return (
    <div className="rounded-card border border-border-opaque bg-background-secondary px-4 py-3">
      <p className="text-paragraph-xsmall text-content-tertiary">The confirmed cause{confirmedBy === null ? "" : `, confirmed by ${confirmedBy.name}`}</p>
      <p className="mt-1 max-w-prose text-paragraph-small whitespace-pre-wrap text-content-primary">{confirmedCause}</p>
    </div>
  );
}

type Line = { key: number; criterion: string; points: number };

function TaskForm({ run, task, people, me, onSaved }: { run: RunRecord; task: RunTask; people: readonly PersonChoice[]; me: PersonId | null; onSaved: (task: RunTask) => void }) {
  const api = useExportApi();
  const ids = useId();
  const [question, setQuestion] = useState(task.question ?? "");
  const [lines, setLines] = useState<Line[]>(() => (task.rubric.length === 0 ? [{ key: 0, criterion: "", points: 5 }] : task.rubric.map((item, key) => ({ key, ...item }))));
  const [reviewer, setReviewer] = useState<string>(task.review?.reviewer?.id ?? people.find((p) => p.id === me)?.id ?? "");
  const [agrees, setAgrees] = useState<boolean | null>(task.review?.agrees ?? null);
  const [notes, setNotes] = useState(task.review?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(task.writtenAt);

  const setLine = (key: number, change: Partial<Line>) => setLines((all) => all.map((line) => (line.key === key ? { ...line, ...change } : line)));
  const total = lines.reduce((sum, line) => sum + line.points, 0);

  const save = async () => {
    const body = SaveTaskRequest.safeParse({ question, rubric: lines.filter((line) => line.criterion.trim() !== "").map(({ criterion, points }) => ({ criterion, points })), reviewerId: reviewer, notes, agrees });
    if (!body.success) {
      setError(reviewer === "" ? "Pick who is reviewing." : (body.error.issues[0]?.message ?? "Check the form and try again."));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const next = await api.saveTask(run.id, body.data);
      setSavedAt(next.writtenAt);
      onSaved(next);
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="mt-5 grid gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-1.5">
        <label htmlFor={`${ids}-who`} className="text-label-medium text-content-primary">
          Who is reviewing?
        </label>
        <select id={`${ids}-who`} value={reviewer} onChange={(e) => setReviewer(e.target.value)} className={cn(inputVariants({ size: "compact" }), "max-w-xs")}>
          <option value="">Pick a person</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-1.5">
        <label htmlFor={`${ids}-question`} className="text-label-medium text-content-primary">
          The question
        </label>
        <p className="max-w-prose text-paragraph-small text-content-tertiary">What you&rsquo;d ask someone who has the files and the protocol but not the answer. For example: &ldquo;Why is there no band at 119 kDa?&rdquo;</p>
        <Textarea id={`${ids}-question`} rows={3} maxLength={4000} value={question} onChange={(e) => setQuestion(e.target.value)} />
      </div>

      <fieldset className="grid gap-2">
        <legend className="text-label-medium text-content-primary">What a good answer says</legend>
        <p className="max-w-prose text-paragraph-small text-content-tertiary">One line for each thing, and how many points it&rsquo;s worth.</p>
        {lines.map((line, i) => (
          <div key={line.key} className="flex flex-wrap items-center gap-2">
            <input
              aria-label={`Line ${i + 1}`}
              value={line.criterion}
              maxLength={500}
              onChange={(e) => setLine(line.key, { criterion: e.target.value })}
              className={cn(inputVariants({ size: "compact" }), "min-w-0 flex-1 basis-64")}
            />
            <select aria-label={`Points for line ${i + 1}`} value={line.points} onChange={(e) => setLine(line.key, { points: Number(e.target.value) })} className={cn(inputVariants({ size: "compact" }), "w-28")}>
              {Array.from({ length: 10 }, (_, n) => n + 1).map((n) => (
                <option key={n} value={n}>
                  {plural(n, "point", "points")}
                </option>
              ))}
            </select>
            <Button type="button" variant="tertiary" size="compact" disabled={lines.length === 1} onClick={() => setLines((all) => all.filter((l) => l.key !== line.key))}>
              Remove
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="compact"
            disabled={lines.length >= MAX_CRITERIA}
            onClick={() => setLines((all) => [...all, { key: Math.max(...all.map((l) => l.key)) + 1, criterion: "", points: 1 }])}
          >
            Add a line
          </Button>
          <span className="text-paragraph-small text-content-tertiary">{plural(total, "point", "points")} in all</span>
        </div>
      </fieldset>

      <fieldset className="grid gap-1">
        <legend className="text-label-medium text-content-primary">Do you agree with the confirmed cause?</legend>
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
          {(
            [
              ["Yes", true],
              ["No", false],
              ["Not sure", null],
            ] as const
          ).map(([label, value]) => (
            <label key={label} className="flex min-h-8 cursor-pointer items-center gap-2 text-paragraph-small text-content-primary max-sm:min-h-11">
              <input type="radio" name={`${ids}-agrees`} checked={agrees === value} onChange={() => setAgrees(value)} className="size-4 accent-[var(--content-primary)]" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-1.5">
        <label htmlFor={`${ids}-notes`} className="text-label-medium text-content-primary">
          Review notes
        </label>
        <p className="max-w-prose text-paragraph-small text-content-tertiary">Why you agree or don&rsquo;t, and anything a reader should know before trusting this answer.</p>
        <Textarea id={`${ids}-notes`} rows={4} maxLength={8000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {error === null ? null : (
        <p role="alert" className="max-w-prose text-paragraph-small text-content-negative">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving" : "Save"}
        </Button>
        {savedAt === null ? null : (
          <span className="text-paragraph-small text-content-tertiary">
            Saved <When iso={savedAt} />
          </span>
        )}
      </div>
    </form>
  );
}

function Preview({ run, preview }: { run: RunRecord; preview: TaskPreview }) {
  const { counts } = preview;
  const asIs = preview.evidence.filter((e) => e.treatment === "as_is");
  return (
    <div className="mt-4 grid gap-4">
      <p className="max-w-prose text-paragraph-small text-content-primary">
        {counts.replacements === 0
          ? "Binary found none of the names it knows in this record."
          : `Binary replaced ${plural(counts.people, "person", "people")}${counts.samples === 0 ? "" : `, ${plural(counts.samples, "sample ID", "sample IDs")}`}${counts.emails === 0 ? "" : `, ${plural(counts.emails, "other email", "other emails")}`} in ${plural(counts.replacements, "place", "places")}.`}
      </p>

      <div className="grid gap-2">
        {preview.parts.map((part) => (
          <details key={part.path} className="rounded-card border border-border-opaque">
            <summary className="cursor-pointer px-4 py-2.5 text-label-medium text-content-primary">{part.path}</summary>
            <pre className="overflow-x-auto border-t border-border-opaque px-4 py-3 font-mono text-paragraph-xsmall whitespace-pre-wrap text-content-primary">{part.text}</pre>
          </details>
        ))}
      </div>

      <div>
        <h3 className="text-label-medium text-content-primary">Files</h3>
        {asIs.length === 0 ? null : (
          <p className="mt-1 max-w-prose text-paragraph-small text-content-primary">
            {asIs.length === 1 ? "One file goes" : `${asIs.length} files go`} in exactly as {asIs.length === 1 ? "it is" : "they are"}. Binary can&rsquo;t look inside an image or a workbook, so open{" "}
            {asIs.length === 1 ? "it" : "each one"} and check that no name is written in it.
          </p>
        )}
        <ul className="mt-2 grid gap-2">
          {preview.evidence.map((file) => (
            <li key={file.path} className="rounded-card border border-border-opaque px-4 py-2.5">
              <p className="text-label-medium break-all text-content-primary">{file.path}</p>
              <p className="mt-0.5 text-paragraph-small break-all text-content-tertiary">
                Was {file.was} · {formatSize(file.bytes)} · {file.treatment === "scrubbed" ? "names replaced inside" : "goes in as it is"}
                {file.treatment === "as_is" ? (
                  <>
                    {" · "}
                    <a href={runFileHref(run.id, file.sourceSha256)} target="_blank" rel="noreferrer" className="text-content-primary underline underline-offset-2">
                      Open it to check
                    </a>
                  </>
                ) : null}
              </p>
              {file.excerpt === null ? null : (
                <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-background-secondary px-3 py-2 font-mono text-paragraph-xsmall text-content-primary">{file.excerpt}</pre>
              )}
            </li>
          ))}
          {preview.leftOut.map((file) => (
            <li key={file.was} className="rounded-card border border-border-opaque px-4 py-2.5">
              <p className="text-label-medium break-all text-content-secondary">{file.was}</p>
              <p className="mt-0.5 text-paragraph-small text-content-tertiary">Left out. {LEFT_OUT_LINES[file.reason]}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// What the lab leaves out of everything it shares. An admin's to change; everyone sees it.
function Exclusions({ run, task, onChanged }: { run: RunRecord; task: RunTask; onChanged: (exclusions: RunTask["exclusions"]) => void }) {
  const api = useExportApi();
  const id = useId();
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const has = (kind: string, value: string) => task.exclusions.some((x) => x.kind === kind && x.value === value);
  const set = async (kind: "field" | "text", value: string, on: boolean) => {
    setBusy(true);
    try {
      onChanged(await api.setExclusion(run.id, { kind, value, on }));
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBusy(false);
    }
  };

  if (!task.canExclude) {
    return (
      <p className="mt-4 max-w-prose text-paragraph-small text-content-tertiary">
        {task.exclusions.length === 0 ? "This lab leaves nothing out. An admin can change that here." : `This lab leaves out: ${task.exclusions.map(exclusionLabel).join(", ")}. An admin can change that here.`}
      </p>
    );
  }
  const phrases = task.exclusions.filter((x) => x.kind === "text");
  return (
    <details className="mt-4 rounded-card border border-border-opaque">
      <summary className="cursor-pointer px-4 py-2.5 text-label-medium text-content-primary">
        What this lab leaves out{task.exclusions.length === 0 ? "" : ` (${task.exclusions.length})`}
      </summary>
      <div className="grid gap-4 border-t border-border-opaque px-4 py-3">
        <p className="max-w-prose text-paragraph-small text-content-tertiary">This is for every run in the lab, not only this one.</p>
        <fieldset disabled={busy} className="grid gap-1 sm:grid-cols-2">
          <legend className="sr-only">Parts of the record and kinds of file to leave out</legend>
          {EXCLUDABLE_FIELDS.map((field) => (
            <label key={field.value} className="flex min-h-8 cursor-pointer items-center gap-2 text-paragraph-small text-content-primary max-sm:min-h-11">
              <input type="checkbox" checked={has("field", field.value)} onChange={(e) => void set("field", field.value, e.target.checked)} className="size-4 accent-[var(--content-primary)]" />
              {field.label}
            </label>
          ))}
        </fieldset>
        <form
          className="grid gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (phrase.trim() === "") return;
            void set("text", phrase.trim(), true).then(() => setPhrase(""));
          }}
        >
          <label htmlFor={id} className="text-label-medium text-content-primary">
            A word or phrase to remove everywhere
          </label>
          <div className="flex flex-wrap gap-2">
            <input id={id} value={phrase} maxLength={400} onChange={(e) => setPhrase(e.target.value)} placeholder="A project's code name, a collaborator" className={cn(inputVariants({ size: "compact" }), "min-w-0 flex-1 basis-56")} />
            <Button type="submit" variant="secondary" size="compact" disabled={busy || phrase.trim() === ""}>
              Add
            </Button>
          </div>
          {phrases.length === 0 ? null : (
            <ul className="mt-1 grid gap-1">
              {phrases.map((x) => (
                <li key={x.value} className="flex items-center justify-between gap-3 text-paragraph-small text-content-primary">
                  <span className="min-w-0 break-words">{x.value}</span>
                  <Button type="button" variant="tertiary" size="compact" disabled={busy} onClick={() => void set("text", x.value, false)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </form>
      </div>
    </details>
  );
}

function Build({ run, task, checked, blocked, onBuilt }: { run: RunRecord; task: RunTask; checked: boolean; blocked: readonly ExportReason[]; onBuilt: (task: RunTask) => void }) {
  const api = useExportApi();
  const [agreed, setAgreed] = useState(false);
  const [building, setBuilding] = useState(false);
  const [refused, setRefused] = useState<readonly ExportReason[] | null>(null);

  const build = async () => {
    setBuilding(true);
    setRefused(null);
    try {
      const outcome = await api.build(run.id);
      if (outcome.kind === "blocked") setRefused(outcome.reasons);
      else {
        onBuilt(outcome.task);
        setAgreed(false);
        toast.success("The folder is built.");
      }
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBuilding(false);
    }
  };

  if (blocked.length > 0) {
    return <p className="max-w-prose text-paragraph-small text-content-tertiary">{task.demo ? "A demo lab's runs can't be built into a folder." : "Finish what's still needed at the top of this page first."}</p>;
  }
  return (
    <div className="grid gap-3">
      {checked ? (
        <label className="flex cursor-pointer items-start gap-2 text-paragraph-small text-content-primary">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--content-primary)]" />
          I&rsquo;ve read the record above and opened the files that go in as they are. No name is left.
        </label>
      ) : (
        <p className="max-w-prose text-paragraph-small text-content-tertiary">Show the record with names taken out and read it first.</p>
      )}
      <div>
        <Button type="button" disabled={!checked || !agreed || building} onClick={() => void build()}>
          {building ? "Building" : "Build the task folder"}
        </Button>
      </div>
      {refused === null ? null : (
        <div role="alert" className="rounded-card border border-border-opaque bg-background-secondary px-4 py-3">
          <p className="text-label-medium text-content-primary">Nothing was built.</p>
          <ul className="mt-1 grid max-w-prose list-disc gap-1 pl-5 text-paragraph-small text-content-primary">
            {refused.map((reason) => (
              <li key={reason}>{REASON_LINES[reason]}</li>
            ))}
          </ul>
          <p className="mt-2 text-paragraph-small text-content-tertiary">The try is written in the run&rsquo;s sharing history.</p>
        </div>
      )}
    </div>
  );
}

function Folders({ run, folders }: { run: RunRecord; folders: readonly BuiltFolder[] }) {
  if (folders.length === 0) return null;
  return (
    <ul className="mt-5 grid gap-2">
      {folders.map((folder) => (
        <li key={folder.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card border border-border-opaque px-4 py-2.5">
          <div className="min-w-0">
            <p className="text-label-medium text-content-primary">
              Built <When iso={folder.builtAt} />
            </p>
            <p className="mt-0.5 max-w-prose text-paragraph-small text-content-tertiary">
              {folder.withdrawnAt === null
                ? `${plural(folder.files, "file", "files")}${folder.bytes === null ? "" : ` · ${formatSize(folder.bytes)}`}`
                : `Sharing was turned off for this run after this was built, so it can't be downloaded. ${folder.hasFiles ? "Binary is removing its copy." : "Binary has removed its copy."} Copies someone already downloaded can't be pulled back.`}
            </p>
          </div>
          {folder.withdrawnAt === null ? (
            <a href={taskDownloadHref(run.id, folder.id)} className={buttonVariants({ variant: "secondary", size: "compact" })}>
              Download
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
