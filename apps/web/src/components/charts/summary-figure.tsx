"use client";
import { Popover } from "radix-ui";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { analyze, type Analysis, type Fact } from "@/lib/analysis";
import type { HistogramSpec, SummarySpec } from "@/lib/charts";
import { LABEL_FONT, textWidth } from "@/lib/chart-geometry";
import { chartNumbers, numbersCsv, type NumberTable } from "@/lib/chart-numbers";
import { cn } from "@/lib/cn";
import type { DataTable } from "@/lib/data-tables";
import { formatFit, formatValue } from "@/lib/numbers";
import { plotSummary, type SummaryPlot, type Target } from "@/lib/summary-geometry";
import { Button } from "../ui/button";
import { menuSurface } from "../ui/menu";
import { chartHeight, EditableLabels, Frame, useWidth, type FigureEdit, type LabelBox } from "./chart-figure";
import { SCREEN_INK } from "./chart-svg";
import { saveText } from "./chart-export";
import { SummarySvg } from "./summary-svg";

// A chart of repeats that fills its container: a readout on hover and the arrow keys, what it
// found in plain words (each explained in a sentence on hover or tap), the samples read off a
// standard curve, and every number behind it a click away.

export function SummaryFigure({
  spec,
  table,
  tables,
  label,
  className,
  edit,
  hint,
}: {
  spec: SummarySpec | HistogramSpec;
  table: DataTable;
  tables: readonly DataTable[];
  label: string;
  className?: string;
  edit?: FigureEdit;
  hint?: ReactNode;
}) {
  const [box, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const clipId = useId();
  const editable = edit !== undefined;
  const analysis = useMemo(() => analyze(table, spec, tables), [table, spec, tables]);
  const plot = useMemo(
    () => (width === null ? null : plotSummary(spec, table, { width, height: chartHeight(width) }, { placeholders: editable }, tables)),
    [spec, table, tables, width, editable],
  );
  const labels = useMemo(() => (plot === null || !editable ? [] : axisLabels(plot)), [plot, editable]);

  function point(event: PointerEvent<SVGRectElement>) {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (plot === null || rect === undefined) return;
    setActive(nearest(plot.targets, event.clientX - rect.left, event.clientY - rect.top));
  }

  function step(event: KeyboardEvent<HTMLDivElement>) {
    if (plot === null || plot.targets.length === 0) return;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 }[event.key];
    if (delta === undefined && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const last = plot.targets.length - 1;
    setActive((cur) => (event.key === "Home" ? 0 : event.key === "End" ? last : Math.max(0, Math.min(last, (cur ?? (delta === 1 ? -1 : last + 1)) + (delta ?? 0)))));
  }

  return (
    <figure className={cn("min-w-0", className)}>
      <Frame
        box={box}
        height={width === null ? 320 : (plot?.height ?? chartHeight(width))}
        label={`${label}. Use the arrow keys to read each point.`}
        onKeyDown={step}
        onFocus={() => setActive((cur) => cur ?? 0)}
        onBlur={() => setActive(null)}
      >
        {plot === null ? null : (
          <SummarySvg plot={plot} ink={SCREEN_INK} clipId={clipId} label={label}>
            {active === null || plot.targets[active] === undefined ? null : <ActiveMark target={plot.targets[active]} plot={plot} />}
            <rect x={plot.area.left} y={plot.area.top} width={plot.area.width} height={plot.area.height} fill="transparent" onPointerMove={point} onPointerLeave={() => setActive(null)} />
          </SummarySvg>
        )}
        {plot === null || active === null || plot.targets[active] === undefined ? null : <TargetReadout plot={plot} target={plot.targets[active]} />}
        {edit === undefined ? null : <EditableLabels labels={labels} edit={edit} />}
      </Frame>
      <figcaption className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-72 text-paragraph-xsmall text-content-tertiary">
          {hint === undefined ? null : <div className="mb-1 flex items-center gap-1.5 pt-2.5">{hint}</div>}
          {plot?.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
        <Button variant="secondary" size="compact" className="shrink-0 text-content-secondary" aria-expanded={showTable} onClick={() => setShowTable((v) => !v)}>
          {showTable ? "Hide the numbers" : "Show the numbers"}
        </Button>
      </figcaption>
      <Facts facts={analysis.facts} />
      {analysis.kind === "curve" && analysis.unknowns.length > 0 ? <SamplesTable analysis={analysis} spec={spec} title={label} /> : null}
      {showTable ? <Numbers tables={chartNumbers(spec, analysis)} /> : null}
    </figure>
  );
}

function nearest(targets: readonly Target[], x: number, y: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  targets.forEach((t, i) => {
    const inside = x >= t.left && x <= t.right;
    const d = (inside ? 0 : Math.min(Math.abs(x - t.left), Math.abs(x - t.right)) * 3) + Math.abs(y - t.py) * 0.15;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return bestD < 60 ? best : null;
}

function ActiveMark({ target, plot }: { target: Target; plot: SummaryPlot }) {
  return (
    <g pointerEvents="none">
      <rect x={target.left} y={plot.area.top} width={Math.max(1, target.right - target.left)} height={plot.area.height} fill="var(--content-primary)" fillOpacity={0.04} />
      <circle cx={target.px} cy={target.py} r={7} fill="none" stroke="var(--content-primary)" strokeWidth={1.5} />
    </g>
  );
}

function TargetReadout({ plot, target }: { plot: SummaryPlot; target: Target }) {
  const onLeft = target.px > plot.area.left + plot.area.width / 2;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 max-w-72 min-w-40 rounded-control border border-border-opaque bg-background-raised px-3 py-2 shadow-deep-below"
      style={{ top: plot.area.top, ...(onLeft ? { right: plot.width - target.left + 8 } : { left: target.right + 8 }) }}
    >
      <p className="text-label-small text-content-primary">{target.title}</p>
      <ul className="mt-1 grid gap-0.5">
        {target.lines.map((line) => (
          <li key={line} className="text-paragraph-xsmall text-content-secondary tabular-nums">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function axisLabels(plot: SummaryPlot): LabelBox[] {
  const out: LabelBox[] = [];
  const pad = 6;
  const inputWidth = (w: number) => Math.min(plot.width, Math.max(200, w + 48));
  if (plot.xTitle !== null) {
    const w = textWidth(plot.xTitle.text, LABEL_FONT);
    out.push({
      target: { kind: "x" },
      text: plot.xTitle.text,
      name: "the bottom axis title",
      rotate: false,
      style: { left: plot.xTitle.x - w / 2 - pad, top: plot.xTitle.y - LABEL_FONT - 3, width: w + pad * 2, height: LABEL_FONT + 10 },
      input: { left: Math.max(0, Math.min(plot.width - inputWidth(w), plot.xTitle.x - inputWidth(w) / 2)), top: plot.xTitle.y - LABEL_FONT - 9, width: inputWidth(w) },
    });
  }
  if (plot.yTitle !== null) {
    const w = textWidth(plot.yTitle.text, LABEL_FONT);
    out.push({
      target: { kind: "y" },
      text: plot.yTitle.text,
      name: "the side axis title",
      rotate: true,
      style: { left: plot.yTitle.x - (LABEL_FONT + 10) / 2 - 4, top: plot.yTitle.y - w / 2 - pad, width: LABEL_FONT + 10, height: w + pad * 2 },
      input: { left: 0, top: plot.yTitle.y - 18, width: inputWidth(w) },
    });
  }
  return out;
}

// What the chart found, plain question first, its technical answer second. Hovering or
// tapping the answer explains it in a sentence.
export function Facts({ facts }: { facts: readonly Fact[] }) {
  if (facts.length === 0) return null;
  return (
    <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
      {facts.map((f) => (
        <div key={`${f.question}${f.answer}`} className="min-w-0">
          <dt className="text-paragraph-xsmall text-content-tertiary">{f.question}</dt>
          <dd className="min-w-0">
            <Explained text={f.explain}>{f.answer}</Explained>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// A statistic that explains itself: on hover with a pointer, on tap or Enter anywhere.
export function Explained({ text, children }: { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const hovering = useRef(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          onPointerEnter={(e) => {
            if (e.pointerType !== "mouse") return;
            hovering.current = true;
            setOpen(true);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType !== "mouse") return;
            hovering.current = false;
            setOpen(false);
          }}
          className="text-left text-label-small text-content-primary underline decoration-border-raised decoration-dotted underline-offset-4 hover:decoration-content-tertiary focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-border-accent"
        >
          {children}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={12} onOpenAutoFocus={(e) => e.preventDefault()} className={cn(menuSurface, "max-w-80 px-3 py-2.5 text-paragraph-small text-content-secondary")}>
          {text}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// The samples read off a standard curve, as students hand them in, with their own download.
// Units a sample's amount can be shown in, as multiples of the one it was measured in.
const CONVERSIONS: Record<string, { unit: string; by: number }[]> = {
  "µg/mL": [{ unit: "mg/mL", by: 1 / 1000 }],
  "ng/mL": [{ unit: "µg/mL", by: 1 / 1000 }],
  "mg/mL": [{ unit: "µg/mL", by: 1000 }],
  "µM": [{ unit: "nM", by: 1000 }, { unit: "mM", by: 1 / 1000 }],
};

function SamplesTable({ analysis, spec, title }: { analysis: Extract<Analysis, { kind: "curve" }>; spec: SummarySpec | HistogramSpec; title: string }) {
  const measured = analysis.grouped.key.unit;
  const choices = [{ unit: measured, by: 1 }, ...(CONVERSIONS[measured] ?? [])];
  const [shownUnit, setShownUnit] = useState(measured);
  const by = choices.find((c) => c.unit === shownUnit)?.by ?? 1;
  const unit = choices.some((c) => c.unit === shownUnit) ? shownUnit : measured;
  const u = unit ? ` (${unit})` : "";
  const amount = (v: number | null) => (v === null ? "—" : formatFit(v * by));
  const diluted = analysis.unknowns.some((k) => k.dilution !== null && k.dilution !== 1);
  const samples = chartNumbers(spec, analysis).find((t) => t.title === "Samples");
  return (
    <section aria-label="Your samples" className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-label-medium text-content-primary">Your samples, read off the line</h3>
        {choices.length > 1 ? (
          <div role="radiogroup" aria-label="Show amounts in" className="inline-flex rounded-control bg-background-secondary p-0.5 ring-1 ring-border-opaque ring-inset">
            {choices.map((c) => (
              <button
                key={c.unit}
                type="button"
                role="radio"
                aria-checked={c.unit === unit}
                onClick={() => setShownUnit(c.unit)}
                className={cn("min-h-9 rounded-[8px] px-2.5 text-label-small sm:min-h-7", c.unit === unit ? "bg-background-raised text-content-primary shadow-raised" : "text-content-secondary hover:text-content-primary")}
              >
                {c.unit}
              </button>
            ))}
          </div>
        ) : null}
        {samples === undefined ? null : (
          <Button variant="tertiary" size="compact" className="-mr-2 text-content-secondary" onClick={() => saveText(numbersCsv([samples], [title]), `${title} samples.csv`, "text/csv")}>
            Download as CSV
          </Button>
        )}
      </div>
      <div className="mt-2 overflow-x-auto rounded-control border border-border-opaque">
        <table className="w-full text-left text-paragraph-xsmall tabular-nums">
          <thead className="bg-background-secondary">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium text-content-secondary">Sample</th>
              <th scope="col" className="px-3 py-2 font-medium text-content-secondary">Reading{analysis.blank === null ? "" : ", blank taken off"}</th>
              <th scope="col" className="px-3 py-2 font-medium text-content-secondary">In the well{u}</th>
              {diluted ? <th scope="col" className="px-3 py-2 font-medium text-content-secondary">In the sample{u}</th> : null}
            </tr>
          </thead>
          <tbody>
            {analysis.unknowns.map((k) => (
              <tr key={k.label} className="border-t border-border-opaque align-top">
                <td className="px-3 py-1.5 text-content-primary">
                  {k.label}
                  {k.n > 1 ? <span className="text-content-tertiary"> · {k.n} wells</span> : null}
                </td>
                <td className="px-3 py-1.5 text-content-primary">{formatFit(k.reading)}</td>
                <td className="px-3 py-1.5 text-content-primary">
                  {k.outside === null ? amount(k.conc) : `${amount(k.conc)}?`}
                  {k.outside === null ? null : <span className="block text-content-secondary">Outside your standards, so this number is a guess</span>}
                </td>
                {diluted ? (
                  <td className="px-3 py-1.5 text-content-primary">
                    {k.outside === null ? amount(k.original) : `${amount(k.original)}?`}
                    {k.dilution !== null && k.dilution !== 1 ? <span className="text-content-tertiary"> (× {formatValue(k.dilution)}, its dilution)</span> : null}
                    {k.outside === null ? null : <span className="block text-content-secondary">A guess too</span>}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function show(v: string | number | null): string {
  if (v === null) return "";
  return typeof v === "number" ? formatValue(v) : v;
}

function Numbers({ tables }: { tables: readonly NumberTable[] }) {
  return (
    <div className="mt-3 grid gap-4">
      {tables.map((t) => (
        <div key={t.title}>
          <p className="text-label-small text-content-secondary">{t.title}</p>
          <div className="mt-1 max-h-96 overflow-auto rounded-control border border-border-opaque">
            <table className="w-full text-left text-paragraph-xsmall tabular-nums">
              {t.columns.every((c) => c === "") ? null : (
                <thead className="sticky top-0 bg-background-secondary">
                  <tr>
                    {t.columns.map((c, i) => (
                      <th key={i} scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-content-secondary">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {t.rows.map((r, i) => (
                  <tr key={i} className="border-t border-border-opaque first:border-t-0">
                    {r.map((v, j) => (
                      <td key={j} className={cn("px-3 py-1.5 text-content-primary", j === r.length - 1 && typeof v === "string" && v.length > 40 ? "min-w-64" : "whitespace-nowrap")}>
                        {show(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
