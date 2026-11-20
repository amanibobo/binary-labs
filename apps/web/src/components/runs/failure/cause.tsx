"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Caption, Input, Textarea } from "@/components/ui/field";
import { When } from "@/components/ui/when";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/format";
import { RunId, Sha256 } from "@/lib/ids";
import { attestState, CAUSE_MAX, METHOD_CHOICES, methodWords, NOTE_MAX, type ConfirmDraft, type ConfirmerChoice, type Evidence } from "@/lib/run-failure";
import { ConfirmMethod, statusLabel, type RunRecord, type RunRef } from "@/lib/run-record";
import { runHref, useRunsApi } from "../runs-api";

// Resolves true once the run the write returned is on screen; a refusal has shown its toast.
export type Write = (action: () => Promise<RunRecord>) => Promise<boolean>;

export const quietAction =
  "-mx-1.5 inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-label-small text-content-primary transition-colors duration-150 ease-out hover:bg-background-tertiary disabled:text-content-tertiary disabled:hover:bg-transparent max-sm:min-h-11";
const select =
  "h-8 w-full max-w-md rounded-md border border-border-opaque bg-background-primary px-1.5 text-paragraph-small text-content-primary max-sm:h-11 max-sm:text-paragraph-medium";

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <h3 className="text-label-medium text-content-primary">{title}</h3>
      {children}
    </div>
  );
}

// What someone thinks went wrong. Anyone in the lab may write it or change it.
export function SuspectedCause({ run, disabled, write }: { run: RunRecord; disabled: boolean; write: Write }) {
  const api = useRunsApi();
  const saved = run.failure.suspectedCause;
  const [editing, setEditing] = useState(saved === null);
  const [text, setText] = useState(saved ?? "");
  const id = useId();
  const save = async () => {
    const next = text.trim();
    if (await write(() => api.setSuspectedCause(run.id, next === "" ? null : next))) setEditing(next === "");
  };

  return (
    <Part title="What do you think went wrong?">
      {!editing && saved !== null ? (
        <>
          <p className="max-w-prose text-paragraph-medium break-words whitespace-pre-line text-content-primary">{saved}</p>
          <div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setText(saved);
                setEditing(true);
              }}
              className={quietAction}
            >
              Change
            </button>
          </div>
        </>
      ) : (
        <form
          className="grid max-w-prose gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor={id} className="sr-only">
            What do you think went wrong?
          </label>
          <Textarea id={id} rows={2} maxLength={CAUSE_MAX} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: the transfer buffer was a month old." />
          <Caption>Your best guess is fine. It doesn&rsquo;t need anyone to confirm it.</Caption>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="compact" disabled={disabled || text.trim() === (saved ?? "")}>
              Save
            </Button>
            {saved === null ? null : (
              <Button type="button" variant="tertiary" size="compact" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </Part>
  );
}

function RunLink({ run }: { run: RunRef }) {
  return (
    <Link href={runHref(run.id)} className="text-content-primary underline decoration-content-tertiary underline-offset-4 hover:decoration-content-primary">
      {run.title}
    </Link>
  );
}

// The cause once a person confirmed it: who, how, when, and the confirmer's own yes.
export function ConfirmedCause({ run, people, disabled, write }: { run: RunRecord; people: readonly ConfirmerChoice[] | undefined; disabled: boolean; write: Write }) {
  const api = useRunsApi();
  const [editing, setEditing] = useState(false);
  const f = run.failure;

  if (editing || f.confirmedCause === null || f.confirmedBy === null || f.confirmMethod === null || f.confirmedAt === null) {
    return (
      <Part title="Confirmed cause">
        {editing ? (
          <ConfirmForm
            run={run}
            people={people}
            disabled={disabled}
            onCancel={() => setEditing(false)}
            onSave={async (draft) => {
              if (await write(() => api.confirmCause(run.id, draft))) setEditing(false);
            }}
          />
        ) : (
          <>
            <Caption className="max-w-prose">Not confirmed yet. Once a control, a repeat or the PI shows what the cause was, write it here with who confirmed it.</Caption>
            <div>
              <Button type="button" variant="secondary" size="compact" disabled={disabled} onClick={() => setEditing(true)} className="mt-1">
                Confirm the cause
              </Button>
            </div>
          </>
        )}
      </Part>
    );
  }

  const control = f.confirmMethod === "control" ? run.files.find((file) => file.sha256 === f.confirmSha256) : undefined;
  const attest = people === undefined ? null : attestState(f, people);
  return (
    <Part title="Confirmed cause">
      <p className="max-w-prose text-paragraph-medium break-words whitespace-pre-line text-content-primary">{f.confirmedCause}</p>
      <p className="max-w-prose text-paragraph-small text-content-secondary">
        Confirmed by {f.confirmedBy.name} {methodWords(f.confirmMethod)}
        {control === undefined ? null : <> ({control.name})</>}
        {f.confirmRun === null ? null : (
          <>
            {" "}
            in <RunLink run={f.confirmRun} />
          </>
        )}{" "}
        on <When iso={f.confirmedAt} />.
      </p>
      {f.confirmNote === null ? null : <p className="max-w-prose text-paragraph-small break-words whitespace-pre-line text-content-secondary">{f.confirmNote}</p>}
      {attest === null ? null : <Attest run={run} state={attest} disabled={disabled} write={write} />}
      <div className="flex flex-wrap gap-x-4">
        <button type="button" disabled={disabled} onClick={() => setEditing(true)} className={quietAction}>
          Change
        </button>
        <button type="button" disabled={disabled} onClick={() => void write(() => api.withdrawCause(run.id))} className={quietAction}>
          Take back the confirmation
        </button>
      </div>
    </Part>
  );
}

function Attest({ run, state, disabled, write }: { run: RunRecord; state: NonNullable<ReturnType<typeof attestState>>; disabled: boolean; write: Write }) {
  const api = useRunsApi();
  switch (state.kind) {
    case "attested":
      return (
        <p className="text-paragraph-small text-content-secondary">
          {run.failure.confirmedBy?.name} said yes from their own account on <When iso={state.at} />.
        </p>
      );
    case "yours":
      return (
        <div className="mt-1 max-w-prose rounded-card border border-border-opaque bg-background-secondary px-4 py-3">
          <p className="text-paragraph-small text-content-primary">You&rsquo;re named as the confirmer. Nothing about this run can be shared outside the lab until you say yes.</p>
          <Button type="button" size="compact" disabled={disabled} onClick={() => void write(() => api.attestCause(run.id))} className="mt-2">
            Yes, I confirmed this
          </Button>
        </div>
      );
    case "waiting":
      return <Caption className="max-w-prose">Waiting for {state.name} to say yes from their own account. Until then, nothing about this run can be shared outside the lab.</Caption>;
    case "no_account":
      return (
        <Caption className="max-w-prose">
          {state.name} can&rsquo;t sign in to Binary yet, so they can&rsquo;t say yes. Until they do, nothing about this run can be shared outside the lab.
        </Caption>
      );
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

// Today in the reader's own zone, as a calendar day.
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dayOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A day picked as when it was confirmed. Today is now; an earlier day is its midday, so the
// day reads the same wherever it's opened.
function confirmedAtOf(day: string, kept: string | null): string | null {
  if (kept !== null && dayOf(kept) === day) return kept;
  return day === today() ? null : new Date(`${day}T12:00:00`).toISOString();
}

type Picked = { method: ConfirmMethod | null; sha256: string; runId: string };

function evidenceOf(picked: Picked): Evidence | null {
  switch (picked.method) {
    case null:
      return null;
    case "control": {
      const sha = Sha256.safeParse(picked.sha256);
      return sha.success ? { method: "control", sha256: sha.data } : null;
    }
    case "repeat":
      return { method: "repeat", runId: picked.runId === "" ? null : RunId.parse(picked.runId) };
    case "pi_opinion":
      return { method: "pi_opinion" };
    default: {
      const _exhaustive: never = picked.method;
      return _exhaustive;
    }
  }
}

function ConfirmForm({
  run,
  people,
  disabled,
  onSave,
  onCancel,
}: {
  run: RunRecord;
  people: readonly ConfirmerChoice[] | undefined;
  disabled: boolean;
  onSave: (draft: ConfirmDraft) => void;
  onCancel: () => void;
}) {
  const f = run.failure;
  const ids = { cause: useId(), person: useId(), method: useId(), file: useId(), repeat: useId(), day: useId(), note: useId() };
  const [cause, setCause] = useState(f.confirmedCause ?? f.suspectedCause ?? "");
  const [personId, setPersonId] = useState<string>(f.confirmedBy?.id ?? "");
  const [picked, setPicked] = useState<Picked>({ method: f.confirmMethod, sha256: f.confirmSha256 ?? "", runId: f.confirmRun?.id ?? "" });
  const [day, setDay] = useState(f.confirmedAt === null ? today() : dayOf(f.confirmedAt));
  const [note, setNote] = useState(f.confirmNote ?? "");
  // The runs a repeat most likely is: the one this retried and the ones that retried it.
  const repeats = [...run.retriedIn, ...(run.retryOf === null ? [] : [run.retryOf])];
  const evidence = evidenceOf(picked);
  const person = people?.find((p) => p.id === personId);
  const ready = cause.trim() !== "" && person !== undefined && evidence !== null && day !== "" && day <= today();

  return (
    <form
      className="grid max-w-prose gap-5 rounded-card border border-border-opaque px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onSave({ cause: cause.trim(), personId: person.id, evidence, note: note.trim() === "" ? null : note.trim(), confirmedAt: confirmedAtOf(day, f.confirmedAt) });
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="grid gap-1.5">
        <label htmlFor={ids.cause} className="text-label-medium text-content-primary">
          What was the cause?
        </label>
        <Textarea id={ids.cause} autoFocus rows={2} maxLength={CAUSE_MAX} value={cause} onChange={(e) => setCause(e.target.value)} />
      </div>

      <div className="grid gap-1.5">
        <label htmlFor={ids.person} className="text-label-medium text-content-primary">
          Who confirmed it?
        </label>
        {people !== undefined && people.length === 0 ? (
          <Caption>
            Your lab has no People yet. Add the person in{" "}
            <Link href="/settings/people" className="underline underline-offset-4">
              Settings, People
            </Link>
            , then come back.
          </Caption>
        ) : (
          <select id={ids.person} value={personId} onChange={(e) => setPersonId(e.target.value)} className={select}>
            <option value="">{people === undefined ? "Loading the lab's people" : "Pick a person"}</option>
            {(people ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.you ? `${p.name} (you)` : p.name}
              </option>
            ))}
          </select>
        )}
        <Caption>Someone else can be named here. They say yes from their own account later.</Caption>
      </div>

      <fieldset className="grid gap-1">
        <legend className="mb-1 text-label-medium text-content-primary">How was it confirmed?</legend>
        {METHOD_CHOICES.map((choice) => (
          <label key={choice.method} className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-background-secondary has-[:checked]:bg-background-secondary">
            <input
              type="radio"
              name={ids.method}
              checked={picked.method === choice.method}
              onChange={() => setPicked((p) => ({ ...p, method: ConfirmMethod.parse(choice.method) }))}
              className="mt-1 size-4 shrink-0 accent-[var(--content-primary)]"
            />
            <span>
              <span className="block text-label-medium text-content-primary">{choice.label}</span>
              <span className="block text-paragraph-small text-content-secondary">{choice.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {picked.method === "control" ? (
        <div className="grid gap-1.5">
          <label htmlFor={ids.file} className="text-label-medium text-content-primary">
            Which file shows it?
          </label>
          <select id={ids.file} value={picked.sha256} onChange={(e) => setPicked((p) => ({ ...p, sha256: e.target.value }))} className={select}>
            <option value="">Pick one of this run&rsquo;s files</option>
            {run.files.map((file) => (
              <option key={file.sha256} value={file.sha256}>
                {file.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {picked.method === "repeat" ? (
        <div className="grid gap-1.5">
          <label htmlFor={ids.repeat} className="text-label-medium text-content-primary">
            Which run was the repeat?
          </label>
          <select id={ids.repeat} value={picked.runId} onChange={(e) => setPicked((p) => ({ ...p, runId: e.target.value }))} className={select}>
            <option value="">It isn&rsquo;t a run in Binary</option>
            {repeats.map((r) => (
              <option key={r.id} value={r.id}>
                {[r.title, r.startedOn === null ? null : formatDay(r.startedOn), statusLabel(r.status).toLowerCase()].filter((p) => p !== null).join(", ")}
              </option>
            ))}
          </select>
          {repeats.length === 0 ? <Caption>Link the retry under Retries to pick it here.</Caption> : null}
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <label htmlFor={ids.day} className="text-label-medium text-content-primary">
          When was it confirmed?
        </label>
        <Input id={ids.day} type="date" size="compact" max={today()} value={day} onChange={(e) => setDay(e.target.value)} className="max-w-48" />
      </div>

      <div className="grid gap-1.5">
        <label htmlFor={ids.note} className="text-label-medium text-content-primary">
          Anything else? <span className="text-content-tertiary">(optional)</span>
        </label>
        <Textarea id={ids.note} rows={2} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: fresh buffer fixed it on the second try." />
      </div>

      <div className={cn("flex flex-wrap gap-2")}>
        <Button type="submit" size="compact" disabled={disabled || !ready}>
          Save the confirmed cause
        </Button>
        <Button type="button" variant="tertiary" size="compact" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
