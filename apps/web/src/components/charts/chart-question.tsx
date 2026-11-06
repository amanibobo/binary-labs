"use client";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { kindChoiceProblem, kindsFor, startChart, suggestionsFor } from "@/lib/chart-guide";
import type { DataTables } from "@/lib/data-tables";
import { describeLayout, type SavedLayout } from "@/lib/layouts";
import { plateLayout } from "@/lib/plates";
import { KIND_NAMES, KIND_QUESTIONS, type ChartData, type ChartKind } from "@/lib/summary-guide";
import { ChevronDownIcon } from "../icons/base-web";
import { Button } from "../ui/button";
import { ChartKindGlyph, ChartThumb } from "./chart-thumb";
import { Segmented } from "./chart-panel";

// A new chart's first and only question: what the student wants to show. Three answers are
// suggested for this sheet, each with why in a line and a small picture of their own data; the
// other kinds wait under "Other kinds of chart". A plate whose wells aren't marked yet offers
// marking them first, or a layout saved before.
export function ChartQuestion({
  doc,
  data,
  saved,
  onSheet,
  onPick,
  onMark,
  onUseLayout,
}: {
  doc: DataTables;
  data: ChartData;
  saved: readonly SavedLayout[];
  onSheet: (name: string) => void;
  onPick: (kind: ChartKind) => void;
  onMark: () => void;
  onUseLayout: (layout: SavedLayout) => void;
}) {
  const suggestions = useMemo(() => suggestionsFor(data).slice(0, 3), [data]);
  const others = kindsFor(data).filter((k) => !suggestions.some((s) => s.kind === k));
  const [more, setMore] = useState(suggestions.length === 0);
  const plate = plateLayout(data.table);
  const markable = plate !== null && plate.kind !== "read";
  const top = suggestions[0];
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-10 pb-24 sm:px-8 sm:pt-14">
      <h1 className="text-heading-medium text-content-primary sm:text-heading-large">What do you want to show?</h1>
      <p className="mt-2 max-w-2xl text-paragraph-medium text-content-secondary">
        {top === undefined ? "This sheet has no numbers to draw. Try another sheet." : `We suggest ${KIND_QUESTIONS[top.kind].question.toLowerCase()}. ${top.reason}`}
      </p>
      {doc.tables.length > 1 ? (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <span className="text-paragraph-small text-content-secondary">Sheet</span>
          <Segmented label="Sheet" options={doc.tables.map((t) => ({ value: t.name, label: t.name }))} value={data.table.name} onChange={onSheet} />
        </div>
      ) : null}
      {markable ? <PlateStart data={data} saved={saved} onMark={onMark} onUseLayout={onUseLayout} /> : null}
      <ul className={cn("mt-8 grid gap-3 sm:grid-cols-2", suggestions.length >= 3 ? "lg:grid-cols-3" : "")}>
        {suggestions.map((s, i) => (
          <ChoiceCard key={s.kind} kind={s.kind} reason={s.reason} data={data} suggested={i === 0} onPick={() => onPick(s.kind)} />
        ))}
      </ul>
      {others.length === 0 ? null : (
        <div className="mt-8">
          <button
            type="button"
            aria-expanded={more}
            onClick={() => setMore((v) => !v)}
            className="-ml-1 inline-flex min-h-11 items-center gap-1.5 rounded-control px-1 text-label-medium text-content-primary sm:min-h-8"
          >
            <ChevronDownIcon className={cn("size-5 transition-transform duration-150", more ? "" : "-rotate-90")} />
            Other kinds of chart
          </button>
          {more ? (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {others.map((k) => (
                <OtherKind key={k} kind={k} data={data} onPick={() => onPick(k)} />
              ))}
            </ul>
          ) : null}
        </div>
      )}
      <p className="mt-8 text-paragraph-small text-content-tertiary">You can change everything once the chart is drawn. Your file stays as it is.</p>
    </div>
  );
}

// What a plate offers before its chart: its layout as read or marked, or the way to mark it.
function PlateStart({ data, saved, onMark, onUseLayout }: { data: ChartData; saved: readonly SavedLayout[]; onMark: () => void; onUseLayout: (layout: SavedLayout) => void }) {
  const layout = data.layout;
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card bg-background-secondary px-4 py-3">
      <p className="min-w-0 flex-1 basis-72 text-paragraph-small text-content-secondary">
        {layout === null ? (
          "To compare wells or fit a curve, say which are blanks, controls, standards and samples."
        ) : (
          <>
            <span className="text-content-primary">{describeLayout(layout.layout)}.</span> {layout.from === "" ? "" : `From ${layout.from}.`}
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {layout === null
          ? saved.slice(0, 2).map((s) => (
              <Button key={s.id} variant="secondary" size="compact" onClick={() => onUseLayout(s)}>
                Use the layout {s.name.length > 40 ? "saved before" : `“${s.name}”`}
              </Button>
            ))
          : null}
        <Button size="compact" variant={layout === null ? "primary" : "secondary"} onClick={onMark}>
          {layout === null ? "Mark the wells" : "Change the wells"}
        </Button>
      </div>
    </div>
  );
}

function ChoiceCard({ kind, reason, data, suggested, onPick }: { kind: ChartKind; reason: string; data: ChartData; suggested: boolean; onPick: () => void }) {
  const spec = useMemo(() => startChart(data, kind), [data, kind]);
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onPick}
        className={cn(
          "group flex h-full w-full min-w-0 items-center gap-4 rounded-card p-3 text-left ring-inset transition-colors duration-150 sm:flex-col sm:items-stretch sm:gap-0 sm:p-4",
          suggested ? "bg-background-secondary ring-2 ring-border-selected" : "ring-1 ring-border-opaque hover:bg-background-secondary",
        )}
      >
        <span className="flex h-20 w-28 shrink-0 items-center justify-center overflow-hidden rounded-control sm:h-32 sm:w-full">
          {spec === null ? <ChartKindGlyph type={kind} className="size-10 text-content-tertiary" /> : <ChartThumb spec={spec} table={data.table} tables={data.tables} className="h-full w-full p-2" />}
        </span>
        <span className="min-w-0 flex-1 sm:mt-4">
          <span className="block text-label-large text-content-primary">{KIND_QUESTIONS[kind].question}</span>
          <span className="mt-0.5 block text-paragraph-xsmall text-content-tertiary">{KIND_NAMES[kind]}</span>
          <span className="mt-1.5 block text-paragraph-small text-content-secondary">{reason}</span>
          {suggested ? <span className="mt-1 block text-paragraph-xsmall text-content-tertiary">Suggested for this sheet</span> : null}
        </span>
      </button>
    </li>
  );
}

function OtherKind({ kind, data, onPick }: { kind: ChartKind; data: ChartData; onPick: () => void }) {
  const problem = useMemo(() => kindChoiceProblem(data, kind), [data, kind]);
  return (
    <li className="min-w-0">
      <button
        type="button"
        disabled={problem !== null}
        onClick={onPick}
        className={cn(
          "flex h-full w-full min-w-0 items-start gap-3 rounded-control px-3.5 py-3 text-left ring-1 ring-border-opaque ring-inset transition-colors duration-150",
          problem === null ? "hover:bg-background-secondary" : "cursor-not-allowed",
        )}
      >
        <ChartKindGlyph type={kind} className={cn("mt-0.5 size-5 shrink-0", problem === null ? "text-content-secondary" : "text-content-tertiary")} />
        <span className="min-w-0">
          <span className={cn("block text-label-medium", problem === null ? "text-content-primary" : "text-content-tertiary")}>{KIND_QUESTIONS[kind].question}</span>
          <span className="mt-0.5 block text-paragraph-small text-content-tertiary">{problem ?? `${KIND_NAMES[kind]}. ${KIND_QUESTIONS[kind].hint}.`}</span>
        </span>
      </button>
    </li>
  );
}
