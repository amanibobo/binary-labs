"use client";
import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { CHOICES, choiceProblem, choicesFor, recommend, startFor, type Choice } from "@/lib/chart-guide";
import type { ChartType } from "@/lib/charts";
import type { DataTable, DataTables } from "@/lib/data-tables";
import { ChartKindGlyph, ChartThumb } from "./chart-thumb";
import { Segmented } from "./chart-panel";

// A new chart's first and only question: what the student wants to show, answered by picking
// one of a few small pictures of their own data. The suggested one says why in a line.
export function ChartQuestion({
  doc,
  table,
  onSheet,
  onPick,
}: {
  doc: DataTables;
  table: DataTable;
  onSheet: (name: string) => void;
  onPick: (type: ChartType) => void;
}) {
  const suggested = useMemo(() => recommend(table), [table]);
  // The suggested answer first, where a phone sees it without scrolling; the rest keep their order.
  const choices = [...choicesFor(table)].sort((a, b) => Number(b.type === suggested?.type) - Number(a.type === suggested?.type));
  const pick = CHOICES.find((c) => c.type === suggested?.type)?.question ?? null;
  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-10 pb-24 sm:px-8 sm:pt-14">
      <h1 className="text-heading-medium text-content-primary sm:text-heading-large">What do you want to show?</h1>
      <p className="mt-2 max-w-2xl text-paragraph-medium text-content-secondary">
        {suggested === null || pick === null ? (
          "This sheet has no numbers to draw. Try another sheet."
        ) : (
          <>
            We suggest <span className="text-content-primary">{pick.toLowerCase()}</span>. {suggested.reason}
          </>
        )}
      </p>
      {doc.tables.length > 1 ? (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <span className="text-paragraph-small text-content-secondary">Sheet</span>
          <Segmented label="Sheet" options={doc.tables.map((t) => ({ value: t.name, label: t.name }))} value={table.name} onChange={onSheet} />
        </div>
      ) : null}
      <ul className={cn("mt-8 grid gap-3 sm:grid-cols-2", choices.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
        {choices.map((c) => (
          <ChoiceCard key={c.type} choice={c} table={table} suggested={suggested?.type === c.type} onPick={() => onPick(c.type)} />
        ))}
      </ul>
      <p className="mt-8 text-paragraph-small text-content-tertiary">You can change everything once the chart is drawn. Your file stays as it is.</p>
    </div>
  );
}
function ChoiceCard({ choice, table, suggested, onPick }: { choice: Choice; table: DataTable; suggested: boolean; onPick: () => void }) {
  const problem = useMemo(() => choiceProblem(table, choice.type), [table, choice.type]);
  const spec = useMemo(() => (problem === null ? startFor(table, choice.type) : null), [problem, table, choice.type]);
  return (
    <li className="min-w-0">
      <button
        type="button"
        disabled={problem !== null}
        onClick={onPick}
        className={cn(
          "group flex h-full w-full min-w-0 items-center gap-4 rounded-card p-3 text-left ring-inset transition-colors duration-150 sm:flex-col sm:items-stretch sm:gap-0 sm:p-4",
          suggested ? "bg-background-secondary ring-2 ring-border-selected" : "ring-1 ring-border-opaque hover:bg-background-secondary",
          problem !== null ? "cursor-not-allowed hover:bg-transparent" : "",
        )}
      >
        <span className={cn("flex h-20 w-28 shrink-0 items-center justify-center overflow-hidden rounded-control sm:h-32 sm:w-full", problem === null ? "" : "opacity-40")}>
          {spec === null ? <ChartKindGlyph type={choice.type} className="size-10 text-content-tertiary" /> : <ChartThumb spec={spec} table={table} className="h-full w-full p-2" />}
        </span>
        <span className="min-w-0 flex-1 sm:mt-4">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cn("text-label-large", problem === null ? "text-content-primary" : "text-content-tertiary")}>{choice.question}</span>
          </span>
          <span className="mt-1 block text-paragraph-small text-content-tertiary">
            {problem ?? `${choice.kind}. ${choice.hint}.`}
            {suggested ? <span className="block text-content-secondary">Suggested for this sheet</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}
