"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { When } from "@/components/ui/when";
import { planState, type PlanBodies, type PlanChoice } from "@/lib/as-run";
import type { ProtocolVersionId } from "@/lib/ids";
import { protocolHref } from "@/lib/protocols";
import type { RunRecord } from "@/lib/run-record";
import { Markdown } from "../protocols/markdown";
import { Button } from "../ui/button";
import { AsRunEditor } from "./plan/as-run-editor";
import { PlanChanges } from "./plan/plan-changes";
import { PlanPicker } from "./plan/plan-picker";
import { useRunsApi } from "./runs-api";
import { RunSection, type RunSectionSlot } from "./section";

const quietAction =
  "-mx-1.5 inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-label-small text-content-primary transition-colors duration-150 ease-out hover:bg-background-tertiary disabled:text-content-tertiary disabled:hover:bg-transparent max-sm:min-h-11";
const link = "text-content-primary underline decoration-content-tertiary underline-offset-4 hover:decoration-content-primary";

// What the section is doing: showing the run's plan, picking its protocol, or writing down
// what was done (starting from `start`, which came from version `basedOn`).
type Mode = { kind: "view" } | { kind: "picking" } | { kind: "editing"; start: string; basedOn: ProtocolVersionId | null };

// The protocol as written, what was actually done, and the plain list of what changed.
export const PlanSection: RunSectionSlot = ({ run, onChange }) => {
  const api = useRunsApi();
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [saving, setSaving] = useState(false);
  const { planned, asRun } = run.plan;
  const bodies = useQuery({
    queryKey: ["run-plan-bodies", run.id, planned?.versionId ?? null, asRun?.basedOn ?? null],
    queryFn: ({ signal }) => api.planBodies(run.id, signal),
    enabled: planned !== null || asRun !== null,
    staleTime: Infinity,
  });

  const write = async (action: () => Promise<RunRecord>) => {
    setSaving(true);
    try {
      onChange(await action());
      setMode({ kind: "view" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  };
  const pick = (choice: PlanChoice | null) => void write(() => api.setPlan(run.id, choice?.versionId ?? null));
  const save = (body: string, basedOn: ProtocolVersionId | null) => void write(() => api.saveAsRun(run.id, { body, basedOn }));

  let content: ReactNode;
  if (mode.kind === "picking") {
    content = (
      <div className="grid gap-2">
        <PlanPicker runId={run.id} onPick={pick} onCancel={() => setMode({ kind: "view" })} />
        <div className="flex flex-wrap gap-x-4">
          <button type="button" onClick={() => setMode({ kind: "view" })} className={quietAction}>
            Cancel
          </button>
          {planned === null ? null : (
            <button type="button" disabled={saving} onClick={() => pick(null)} className={quietAction}>
              This run had no written protocol
            </button>
          )}
        </div>
      </div>
    );
  } else if (mode.kind === "editing") {
    content = <AsRunEditor start={mode.start} saving={saving} onSave={(body) => save(body, mode.basedOn)} onCancel={() => setMode({ kind: "view" })} />;
  } else if ((planned !== null || asRun !== null) && bodies.data === undefined) {
    content = (
      <p className="text-paragraph-small text-content-tertiary" aria-busy={bodies.isPending}>
        {bodies.isError ? "We couldn't load the protocol. Reload the page to try again." : "Loading the protocol…"}
      </p>
    );
  } else {
    content = <PlanView run={run} bodies={bodies.data ?? { planned: null, basedOn: null }} saving={saving} setMode={setMode} pick={pick} save={save} />;
  }

  return (
    <RunSection title="Protocol" note="The protocol as it was written, and what was actually done. Binary lists every difference.">
      {content}
    </RunSection>
  );
};

type ViewProps = {
  run: RunRecord;
  bodies: PlanBodies;
  saving: boolean;
  setMode: (mode: Mode) => void;
  pick: (choice: PlanChoice | null) => void;
  save: (body: string, basedOn: ProtocolVersionId | null) => void;
};

function PlanView({ run, bodies, saving, setMode, pick, save }: ViewProps) {
  const { planned, asRun } = run.plan;
  const state = planState(run.plan, bodies);
  const editDone = asRun === null ? null : (
    <button type="button" disabled={saving} onClick={() => setMode({ kind: "editing", start: asRun.body, basedOn: asRun.basedOn })} className={quietAction}>
      Change what was done
    </button>
  );
  const savedLine = asRun === null ? null : (
    <p className="text-paragraph-xsmall text-content-tertiary">
      Written down <When iso={asRun.at} />
    </p>
  );
  // The as-run text started from another version than the one picked now.
  const based = bodies.basedOn;
  const comparedNote =
    based !== null && planned !== null && based.versionId !== planned.versionId ? (
      <p className="text-paragraph-small text-content-secondary">
        Compared with version {based.version} of {based.title}, the one this was written from.
      </p>
    ) : null;

  return (
    <div className="grid gap-3">
      {planned === null ? null : (
        <p className="flex flex-wrap items-baseline gap-x-3 text-paragraph-small text-content-secondary">
          <span>
            Planned from{" "}
            <Link href={protocolHref(planned.protocolId, planned.version)} className={link}>
              {planned.title}
            </Link>
            , version {planned.version}
          </span>
          <button type="button" disabled={saving} onClick={() => setMode({ kind: "picking" })} className={quietAction}>
            Change
          </button>
        </p>
      )}
      {comparedNote}

      {state.kind === "no_plan" ? (
        <Suggestion run={run} saving={saving} pick={pick} setMode={setMode} />
      ) : state.kind === "missing" ? (
        <div className="grid gap-2">
          <p className="text-label-medium text-content-primary">Did you follow the protocol exactly?</p>
          <p className="text-paragraph-small text-content-tertiary">Nobody has said yet what was actually done in this run.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="compact" variant="secondary" disabled={saving || bodies.planned === null} onClick={() => save(bodies.planned ?? "", planned?.versionId ?? null)}>
              Yes, exactly as written
            </Button>
            <Button
              size="compact"
              variant="secondary"
              disabled={saving || bodies.planned === null}
              onClick={() => setMode({ kind: "editing", start: bodies.planned ?? "", basedOn: planned?.versionId ?? null })}
            >
              No, I changed something
            </Button>
          </div>
        </div>
      ) : state.kind === "as_written" ? (
        <div className="grid gap-1">
          <p className="text-label-medium text-content-primary">Done exactly as written.</p>
          {savedLine}
          <div>{editDone}</div>
        </div>
      ) : state.kind === "changed" ? (
        <div className="grid gap-2">
          <PlanChanges changes={state.changes} />
          {savedLine}
          <div>{editDone}</div>
        </div>
      ) : state.kind === "too_different" ? (
        <div className="grid gap-2">
          <p className="max-w-prose text-paragraph-small text-content-secondary">
            What was done is too different from the protocol to compare step by step, so here are both.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Text title="As written" body={state.plan} />
            <Text title="As done" body={state.asRun} />
          </div>
          {savedLine}
          <div>{editDone}</div>
        </div>
      ) : (
        <div className="grid gap-2">
          <p className="text-paragraph-small text-content-secondary">No written protocol to compare with. This is what was done:</p>
          <Text title={null} body={state.asRun} />
          {savedLine}
          <div className="flex flex-wrap gap-x-4">
            {editDone}
            <button type="button" disabled={saving} onClick={() => setMode({ kind: "picking" })} className={quietAction}>
              Pick the protocol it followed
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Text({ title, body }: { title: string | null; body: string }) {
  return (
    <div className="min-w-0 rounded-card border border-border-opaque px-4 py-3">
      {title === null ? null : <p className="mb-1 text-label-small text-content-tertiary">{title}</p>}
      <Markdown body={body} className="text-paragraph-small" />
    </div>
  );
}

// No protocol picked yet: offer the one most likely followed, or the picker.
function Suggestion({ run, saving, pick, setMode }: { run: RunRecord; saving: boolean; pick: (choice: PlanChoice) => void; setMode: (mode: Mode) => void }) {
  const api = useRunsApi();
  const choices = useQuery({
    queryKey: ["run-plan-choices", run.id, ""],
    queryFn: ({ signal }) => api.planChoices(run.id, "", signal),
    staleTime: 30_000,
  });
  const suggested = choices.data?.find((c) => c.suggested);
  const writeOwn = (
    <button type="button" disabled={saving} onClick={() => setMode({ kind: "editing", start: "", basedOn: null })} className={quietAction}>
      There&apos;s no written protocol. Write down what was done
    </button>
  );
  if (choices.isPending) return <p className="text-paragraph-small text-content-tertiary">Looking for the protocol…</p>;
  if (suggested === undefined) {
    return (
      <div className="grid gap-2">
        <p className="text-paragraph-small text-content-secondary">No protocol is picked for this run yet.</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Button size="compact" variant="secondary" disabled={saving} onClick={() => setMode({ kind: "picking" })}>
            Pick the protocol
          </Button>
          {writeOwn}
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <p className="text-label-medium text-content-primary">Which protocol did this run follow?</p>
      <p className="text-paragraph-small text-content-secondary">
        Probably <span className="text-content-primary">{suggested.title}</span>, version {suggested.version}. It was the newest version on the day this run
        started.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="compact" variant="secondary" disabled={saving} onClick={() => pick(suggested)}>
          Yes, this one
        </Button>
        <Button size="compact" variant="tertiary" disabled={saving} onClick={() => setMode({ kind: "picking" })}>
          Pick another
        </Button>
      </div>
      {writeOwn}
    </div>
  );
}
