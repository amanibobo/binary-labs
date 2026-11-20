"use client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { MAX_OTHER_RUNS, type XYSpec } from "@/lib/charts";
import { formatDate, type DataTable } from "@/lib/data-tables";
import type { LocationId, Sha256 } from "@/lib/ids";
import { combineRuns, isFailed, runName, type Combined, type RunInfo, type RunState } from "@/lib/runs";
import { tableKey } from "./chart-builder";
import { CheckIcon, DeleteIcon, PlusIcon } from "../icons/base-web";
import { useLabApi } from "../lab-api";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDock } from "../ui/dialog";

// "Runs on this chart" (decisions.md, "charts round 2"): the chart's own file, the other runs it
// draws with the same columns, and a picker for more, the file's experiment first.

// The other runs' tables and labels, and the chart combined with them once they've loaded. A
// chart without other runs isn't combined; `states` is null for a chart that can't take runs.
export function useRuns(file: { sha256: Sha256; name: string; locationId: LocationId | null }, spec: XYSpec | null, table: DataTable): { combined: Combined | null; states: RunState[] | null } {
  const api = useLabApi();
  const others = useMemo(() => spec?.runs ?? [], [spec?.runs]);
  const shas = useMemo(() => [file.sha256, ...others], [file.sha256, others]);
  const infos = useQuery({ queryKey: ["runs", shas], queryFn: ({ signal }) => api.runs(shas, signal), enabled: spec !== null });
  const tables = useQueries({
    queries: others.map((sha) => ({ queryKey: tableKey(sha), queryFn: ({ signal }: { signal: AbortSignal }) => api.dataTable(sha, signal) })),
  });
  // Still being read: drawn once it arrives, and listed as being read until then.
  const docs = tables.map((t) => (t.isPending || t.data?.state === "waiting" || t.data?.state === "missing" ? "reading" : t.data?.state === "ready" ? t.data.tables : null));
  const docsKey = docs.map((d) => (d === null ? 0 : d === "reading" ? 1 : 2)).join("");
  return useMemo(() => {
    if (spec === null) return { combined: null, states: null };
    const known = new Map((infos.data ?? []).map((r) => [r.sha256, r]));
    const info = (sha: Sha256, name: string, locationId: LocationId | null): RunInfo => known.get(sha) ?? { sha256: sha, locationId, name, date: null, outcome: null, experiment: null };
    const base = { run: info(file.sha256, file.name, file.locationId), table };
    if (others.length === 0) return { combined: null, states: [{ run: base.run, drawn: true, why: null }] };
    const loaded = others.flatMap((sha, i) => {
      const doc = docs[i];
      return doc === "reading" || infos.isPending ? [] : [{ run: info(sha, `File ${i + 2}`, null), doc: doc ?? null }];
    });
    const reading = others.filter((sha) => !loaded.some((l) => l.run.sha256 === sha)).map((sha, i) => ({ run: info(sha, `File ${i + 2}`, null), drawn: false, why: "Reading its table…" }));
    const combined = combineRuns(spec, base, loaded);
    return { combined, states: [...combined.runs, ...reading] };
    // docsKey stands for the tables as they arrive; the array itself is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, table, file, others, infos.data, infos.isPending, docsKey]);
}

const runDay = (run: RunInfo) => (run.date === null ? null : formatDate(Date.parse(`${run.date}T00:00:00Z`), false));

function RunLine({ run, own, why }: { run: RunInfo; own: boolean; why: string | null }) {
  const day = runDay(run);
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-label-small text-content-primary">{runName(run)}</span>
      <span className="block truncate text-paragraph-xsmall text-content-tertiary">
        {[day, own ? "This file" : null, isFailed(run) ? "Failed, drawn gray and dashed" : null, why].filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}

export function RunsPanel({ sha, states, onChange }: { sha: Sha256; states: readonly RunState[]; onChange: (runs: Sha256[]) => void }) {
  const [picking, setPicking] = useState(false);
  const headingId = useId();
  const others = states.filter((s) => s.run.sha256 !== sha).map((s) => s.run.sha256);
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <h2 id={headingId} className="text-label-medium text-content-primary">
        Runs on this chart
      </h2>
      <p className="mt-0.5 text-paragraph-small text-content-tertiary">Draw the same columns from other files, such as the rest of an experiment. A run labeled failed is drawn gray and dashed.</p>
      <ul className="mt-3 grid gap-1">
        {states.map((s) => (
          <li key={s.run.sha256} className="flex min-h-11 items-center gap-2 rounded-control px-3 py-1.5 ring-1 ring-border-opaque ring-inset">
            <RunLine run={s.run} own={s.run.sha256 === sha} why={s.drawn ? null : s.why} />
            {s.run.sha256 === sha ? null : (
              <Button variant="tertiary" size="compact" shape="square" className="text-content-secondary" onClick={() => onChange(others.filter((o) => o !== s.run.sha256))} title={`Take ${runName(s.run)} off`}>
                <DeleteIcon className="size-4" />
                <span className="sr-only">Take {runName(s.run)} off the chart</span>
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Button variant="secondary" size="compact" className="mt-3 w-max gap-1.5" onClick={() => setPicking(true)} disabled={others.length >= MAX_OTHER_RUNS}>
        <PlusIcon className="size-4" />
        Add runs
      </Button>
      {picking ? <RunPicker sha={sha} chosen={others} onClose={() => setPicking(false)} onDone={(runs) => (onChange(runs), setPicking(false))} /> : null}
    </section>
  );
}

function RunPicker({ sha, chosen, onClose, onDone }: { sha: Sha256; chosen: readonly Sha256[]; onClose: () => void; onDone: (runs: Sha256[]) => void }) {
  const api = useLabApi();
  const query = useQuery({ queryKey: ["run-choices", sha], queryFn: ({ signal }) => api.runChoices(sha, signal) });
  const [picked, setPicked] = useState<Sha256[]>([...chosen]);
  const choices = query.data?.runs ?? [];
  const experiment = query.data?.experiment ?? null;
  const siblings = choices.filter((r) => experiment !== null && r.experiment === experiment);
  const rest = choices.filter((r) => !siblings.includes(r));
  const full = picked.length >= MAX_OTHER_RUNS;
  const toggle = (s: Sha256) => setPicked((p) => (p.includes(s) ? p.filter((x) => x !== s) : full ? p : [...p, s]));
  const group = (title: string, runs: readonly RunInfo[]) =>
    runs.length === 0 ? null : (
      <div className="grid gap-2">
        <h3 className="text-label-small text-content-secondary">{title}</h3>
        <ul className="grid gap-1.5">
          {runs.map((run) => {
            const on = picked.includes(run.sha256);
            return (
              <li key={run.sha256}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={!on && full}
                  onClick={() => toggle(run.sha256)}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-3 rounded-control px-3 py-2 text-left ring-1 ring-inset transition-colors duration-150",
                    on ? "bg-background-secondary ring-2 ring-border-selected" : "ring-border-opaque hover:bg-background-secondary",
                    !on && full ? "cursor-not-allowed opacity-60 hover:bg-transparent" : "",
                  )}
                >
                  <RunLine run={run} own={false} why={null} />
                  <span className="flex size-5 shrink-0 items-center justify-center">{on ? <CheckIcon className="size-4 text-content-primary" /> : null}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  const allIn = siblings.length > 0 && siblings.every((r) => picked.includes(r.sha256));
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent title="Add runs" aria-describedby={undefined} className="sm:w-[min(640px,calc(100vw-80px))]">
        <p className="px-4 pt-1 text-paragraph-medium text-content-secondary sm:px-6">Each run is drawn with this chart&apos;s columns, found by their names. Up to {MAX_OTHER_RUNS} beside this file.</p>
        <div className="mt-4 grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-4 pb-2 sm:px-6">
          {query.isPending ? <p className="text-paragraph-small text-content-tertiary">Finding this lab&apos;s data sheets…</p> : null}
          {query.isError ? <p className="text-paragraph-small text-content-secondary">We couldn&apos;t list the lab&apos;s files. Try again.</p> : null}
          {experiment !== null && siblings.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-paragraph-small text-content-secondary">
                {siblings.length} other {siblings.length === 1 ? "run" : "runs"} of {experiment}
              </p>
              <Button
                variant="secondary"
                size="compact"
                disabled={allIn}
                onClick={() => setPicked((p) => [...p, ...siblings.map((r) => r.sha256).filter((s) => !p.includes(s))].slice(0, MAX_OTHER_RUNS))}
              >
                {allIn ? "All added" : `Add all of ${experiment}`}
              </Button>
            </div>
          ) : null}
          {group(experiment === null ? "Data sheets" : `In ${experiment}`, siblings)}
          {group(siblings.length === 0 ? "The lab's latest data sheets" : "Other data sheets", rest)}
          {query.isSuccess && choices.length === 0 ? <p className="text-paragraph-small text-content-tertiary">There are no other data sheets in this lab yet.</p> : null}
        </div>
        <DialogDock className="pt-4">
          <Button onClick={() => onDone(picked)}>{picked.length === chosen.length && picked.every((p) => chosen.includes(p)) ? "Done" : `Show ${picked.length === 0 ? "this file alone" : `${picked.length + 1} runs`}`}</Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </DialogDock>
      </DialogContent>
    </Dialog>
  );
}
