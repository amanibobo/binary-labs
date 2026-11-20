"use client";
import { Popover } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { isScaled, isXY, type ChartSpec, type ScaledSpec, type XYSpec } from "@/lib/charts";
import { formatValue, LABEL_FONT, plotChart, pointAt, textWidth, TICK_FONT, xLabel, type Plot, type Point } from "@/lib/chart-geometry";
import { cellText, columnLabel, findColumn, rowsNote, type DataColumn, type DataTable } from "@/lib/data-tables";
import type { LabelTarget } from "@/lib/chart-edits";
import type { ColumnId } from "@/lib/ids";
import { plotScaled, readLabel, scaledHeight, type PlatePlot, type PlateWell } from "@/lib/plate-geometry";
import { PencilIcon } from "../icons/drawn";
import { menuSurface } from "../ui/menu";
import { Button } from "../ui/button";
import { ChartSvg, DASH, PlateSvg, SCREEN_INK } from "./chart-svg";
import { SummaryFigure } from "./summary-figure";

const HIT = 24;
// How far from the pointer a series with its own x still counts as there.
const REACH = 12;
// How near a line the pointer has to be to pick it.
const NEAR_LINE = 10;
const TABLE_ROWS = 500;

export function chartHeight(width: number): number {
  return Math.round(Math.min(480, Math.max(260, width * 0.56)));
}

// What makes a chart editable in place (the builder; a protocol page's chart has none).
export type CellMark = { column: ColumnId; row: number };

export type FigureEdit = {
  rename: (target: LabelTarget, text: string) => void;
  // The text a label edits, which can differ from what's drawn ("A595 (AU)" is title and unit).
  textOf: (target: LabelTarget) => string;
  // What opens when a line, bar or dot is clicked: its name, color and style.
  seriesEditor: (column: ColumnId, close: () => void) => ReactNode;
  // The names are the runs' own (lib/runs.ts), so they aren't renamed on the chart.
  seriesFixed?: boolean;
};

// A chart that fills its container's width, with a readout on hover and focus, and the numbers
// it draws one click away. With `edit`, its words rename in place and its marks open their
// editor when clicked.
export function ChartFigure({
  spec,
  table,
  tables,
  label,
  className,
  edit,
  hint,
  muted,
  mark,
}: {
  spec: ChartSpec;
  table: DataTable;
  // The file's other tables, for a standard curve that reads its samples from another sheet.
  tables?: readonly DataTable[];
  label: string;
  className?: string;
  edit?: FigureEdit;
  // A line under the chart, beside "Show the numbers".
  hint?: ReactNode;
  // Series of failed runs, drawn gray and dashed (lib/runs.ts).
  muted?: ReadonlySet<string>;
  // A cell an answer cited, ringed where the chart draws it.
  mark?: CellMark;
}) {
  if (isScaled(spec)) return <PlateFigure spec={spec} table={table} label={label} className={className} edit={edit} hint={hint} />;
  if (isXY(spec)) return <XYFigure spec={spec} table={table} label={label} className={className} edit={edit} hint={hint} muted={muted} mark={mark} />;
  return <SummaryFigure spec={spec} table={table} tables={tables ?? [table]} label={label} className={className} edit={edit} hint={hint} />;
}

export type LabelBox = { target: LabelTarget; text: string; name: string; style: CSSProperties; rotate: boolean; input: CSSProperties };

const keyOf = (t: LabelTarget) => (t.kind === "series" ? `series-${t.column}` : t.kind);

// Where each renameable word of an x/y chart sits, from its plot.
function xyLabels(plot: Plot, spec: XYSpec): LabelBox[] {
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
  const names = new Map(spec.series.map((s) => [s.column, s.name]));
  for (const item of plot.legend) {
    const s = spec.series.find((q) => q.name === item.name && q.color === item.color && q.stroke === item.stroke);
    if (s === undefined) continue;
    const w = 22 + textWidth(item.name, TICK_FONT);
    out.push({
      target: { kind: "series", column: s.column },
      text: item.name,
      name: `${item.name} in the legend`,
      rotate: false,
      style: { left: item.x - 4, top: item.y - 11, width: w + 10, height: 22 },
      input: { left: Math.max(0, Math.min(plot.width - inputWidth(w), item.x - 4)), top: item.y - 17, width: inputWidth(w) },
    });
  }
  for (const s of plot.series) {
    if (s.label === null) continue;
    const column = spec.series.find((q) => q.column === s.column)?.column;
    if (column === undefined) continue;
    const w = textWidth(names.get(column) ?? s.name, TICK_FONT);
    out.push({
      target: { kind: "series", column },
      text: s.name,
      name: `${s.name} at the end of its line`,
      rotate: false,
      style: { left: s.label.x - 4, top: s.label.y - 11, width: w + 8, height: 22 },
      input: { left: Math.max(0, Math.min(plot.width - inputWidth(w), s.label.x - 4)), top: s.label.y - 17, width: inputWidth(w) },
    });
  }
  return out;
}

// The plate's one renameable word: what its colors stand for, under the scale.
function plateLabels(plot: PlatePlot): LabelBox[] {
  const scale = plot.scale;
  if (scale === null || scale.title === "") return [];
  const w = textWidth(scale.title, LABEL_FONT);
  const y = scale.top + scale.height + 6 + TICK_FONT * 2 + 8;
  return [
    {
      target: { kind: "value" },
      text: scale.title,
      name: "what the colors show",
      rotate: false,
      style: { left: scale.left - 6, top: y - LABEL_FONT - 3, width: w + 12, height: LABEL_FONT + 10 },
      input: { left: Math.max(0, scale.left - 6), top: y - LABEL_FONT - 9, width: Math.min(plot.width, Math.max(220, w + 48)) },
    },
  ];
}

// The renameable words over a chart: each shows a pencil on hover and turns into a text field
// when clicked; Enter or leaving keeps the change, Escape drops it.
export function EditableLabels({ labels, edit }: { labels: readonly LabelBox[]; edit: FigureEdit }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <>
      {labels.map((l, i) => {
        const key = `${keyOf(l.target)}-${i}`;
        return editing === key ? (
          <LabelInput
            key={key}
            style={l.input}
            initial={edit.textOf(l.target)}
            name={l.name}
            onDone={(text) => {
              setEditing(null);
              if (text !== null) edit.rename(l.target, text);
            }}
          />
        ) : (
          <button
            key={key}
            type="button"
            onClick={() => setEditing(key)}
            className="group/label absolute z-[5] cursor-text rounded-[6px] ring-border-raised hover:bg-[color-mix(in_oklab,var(--background-secondary)_55%,transparent)] hover:ring-1 focus-visible:ring-2 focus-visible:ring-border-accent focus-visible:outline-none"
            style={l.style}
          >
            <span className="sr-only">Rename {l.name}</span>
            <PencilIcon
              className={cn(
                "pointer-events-none absolute size-4 rounded-full bg-background-raised p-0.5 text-content-secondary opacity-0 shadow-raised ring-1 ring-border-opaque group-hover/label:opacity-100 group-focus-visible/label:opacity-100",
                l.rotate ? "-top-5 left-1/2 -translate-x-1/2" : "top-1/2 -right-5 -translate-y-1/2",
              )}
            />
          </button>
        );
      })}
    </>
  );
}

function LabelInput({ style, initial, name, onDone }: { style: CSSProperties; initial: string; name: string; onDone: (text: string | null) => void }) {
  const done = useRef(false);
  const finish = (text: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  return (
    <input
      autoFocus
      aria-label={`Rename ${name}`}
      defaultValue={initial}
      maxLength={80}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className="absolute z-20 h-9 rounded-control border border-border-accent bg-background-raised px-2.5 text-paragraph-small text-content-primary shadow-deep-below ring-1 ring-border-accent focus-visible:outline-none"
      style={style}
    />
  );
}

// The series a pointer is on, if any: the dot under it, the bar it's in, or the line nearest it
// at that place along x.
function seriesAt(plot: Plot, type: XYSpec["type"], active: Active | null, x: number, y: number): number | null {
  if (type === "scatter") return active?.kind === "point" ? active.series : null;
  if (type === "bar") {
    const i = plot.series.findIndex((s) => s.bars.some((b) => x >= b.x - 2 && x <= b.x + b.width + 2 && y >= b.top - 4 && y <= b.bottom));
    return i < 0 ? null : i;
  }
  if (active?.kind !== "row") return null;
  let best: number | null = null;
  let bestD = NEAR_LINE;
  for (const { series, point } of activePoints(plot, active)) {
    const d = Math.abs(point.py - y);
    if (d <= bestD) {
      bestD = d;
      best = series;
    }
  }
  return best;
}

// The editor a clicked mark opens, beside where it was clicked.
function MarkPopover({ at, onClose, children }: { at: { x: number; y: number } | null; onClose: () => void; children: ReactNode }) {
  return (
    <Popover.Root open={at !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <Popover.Anchor asChild>
        <span aria-hidden className="pointer-events-none absolute size-px" style={at === null ? { left: 0, top: 0 } : { left: at.x, top: at.y }} />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content side="right" align="start" sideOffset={10} collisionPadding={12} className={cn(menuSurface, "w-72 p-4")}>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function useWidth(): [React.RefObject<HTMLDivElement | null>, number | null] {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [box, width];
}

function Caption({ notes, hint, showTable, onToggle }: { notes: string[]; hint?: ReactNode; showTable: boolean; onToggle: () => void }) {
  return (
    <figcaption className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-72 text-paragraph-xsmall text-content-tertiary">
        {hint === undefined ? null : <div className="mb-1 flex items-center gap-1.5 pt-2.5">{hint}</div>}
        {notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </div>
      <Button variant="secondary" size="compact" className="shrink-0 text-content-secondary" aria-expanded={showTable} onClick={onToggle}>
        {showTable ? "Hide the numbers" : "Show the numbers"}
      </Button>
    </figcaption>
  );
}

export function Frame({
  box,
  height,
  label,
  onKeyDown,
  onFocus,
  onBlur,
  children,
}: {
  box: React.RefObject<HTMLDivElement | null>;
  height: number;
  label: string;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  children: ReactNode;
}) {
  return (
    <div
      ref={box}
      tabIndex={0}
      onKeyDown={onKeyDown}
      // Only the chart itself, not a word being renamed on it, starts the keyboard readout.
      onFocus={(e) => (e.target === e.currentTarget ? onFocus() : undefined)}
      onBlur={(e) => (e.target === e.currentTarget ? onBlur() : undefined)}
      aria-label={label}
      className="relative w-full rounded-control focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-accent"
      style={{ height }}
    >
      {children}
    </div>
  );
}

// What the hover layer points at: a place along x (line and bar), or one dot (scatter).
type Active = { kind: "row"; stop: number } | { kind: "point"; series: number; index: number };

function XYFigure({ spec, table, label, className, edit, hint, muted, mark }: { spec: XYSpec; table: DataTable; label: string; className?: string; edit?: FigureEdit; hint?: ReactNode; muted?: ReadonlySet<string>; mark?: CellMark }) {
  const [box, width] = useWidth();
  const [active, setActive] = useState<Active | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [onMark, setOnMark] = useState<number | null>(null);
  const [opened, setOpened] = useState<{ column: ColumnId; x: number; y: number } | null>(null);
  const clipId = useId();
  const editable = edit !== undefined;

  const plot = useMemo(
    () => (width === null ? null : plotChart(spec, table, { width, height: chartHeight(width) }, { placeholders: editable, muted })),
    [spec, table, width, editable, muted],
  );
  const notes = [...(plot?.notes ?? []), ...columnNotes(spec, table), rowsNote(table)].filter((n): n is string => n !== null);
  const fixedNames = edit?.seriesFixed === true;
  const cited = mark === undefined ? undefined : plot?.series.find((s) => s.column === mark.column)?.points.find((p) => p.row === mark.row);
  const labels = useMemo(() => (plot === null || !editable ? [] : xyLabels(plot, spec).filter((l) => !(fixedNames && l.target.kind === "series"))), [plot, spec, editable, fixedNames]);

  function at(event: PointerEvent<SVGRectElement>): { x: number; y: number } | null {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    return rect === undefined ? null : { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function point(event: PointerEvent<SVGRectElement>) {
    const p = at(event);
    if (plot === null || p === null) return;
    const next = nearest(plot, spec.type, p.x, p.y);
    setActive(next);
    if (editable) setOnMark(seriesAt(plot, spec.type, next, p.x, p.y));
  }

  function open(event: PointerEvent<SVGRectElement>) {
    const p = at(event);
    if (plot === null || p === null || !editable) return;
    const i = seriesAt(plot, spec.type, nearest(plot, spec.type, p.x, p.y), p.x, p.y);
    const column = i === null ? undefined : spec.series.find((s) => s.column === plot.series[i]?.column)?.column;
    if (column !== undefined && !fixedNames) setOpened({ column, ...p });
  }

  function step(event: KeyboardEvent<HTMLDivElement>) {
    if (plot === null) return;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 }[event.key];
    if (delta === undefined && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    setActive((cur) => moved(plot, spec.type, cur, event.key === "Home" ? "first" : event.key === "End" ? "last" : (delta ?? 0)));
  }

  return (
    <figure className={cn("min-w-0", className)}>
      <Frame
        box={box}
        height={width === null ? 320 : chartHeight(width)}
        label={`${label}. Use the arrow keys to read values.`}
        onKeyDown={step}
        onFocus={() => setActive((cur) => cur ?? (plot === null ? null : moved(plot, spec.type, null, "first")))}
        onBlur={() => setActive(null)}
      >
        {plot === null ? null : (
          <ChartSvg plot={plot} ink={SCREEN_INK} clipId={clipId} label={label}>
            <HoverMarks plot={plot} active={active} />
            {cited === undefined ? null : <circle cx={cited.px} cy={cited.py} r={8} fill="none" stroke={SCREEN_INK.title} strokeWidth={2} pointerEvents="none"><title>The cell the answer cited</title></circle>}
            <rect
              x={plot.area.left}
              y={plot.area.top}
              width={plot.area.width}
              height={plot.area.height}
              fill="transparent"
              style={{ cursor: onMark === null ? undefined : "pointer" }}
              onPointerMove={point}
              onPointerUp={open}
              onPointerLeave={() => {
                setActive(null);
                setOnMark(null);
              }}
            />
          </ChartSvg>
        )}
        {plot === null || active === null || opened !== null ? null : (
          <Readout plot={plot} spec={spec} table={table} active={active} hint={onMark === null ? null : (plot.series[onMark]?.name ?? null)} />
        )}
        {edit === undefined ? null : <EditableLabels labels={labels} edit={edit} />}
        {edit === undefined ? null : (
          <MarkPopover at={opened} onClose={() => setOpened(null)}>
            {opened === null ? null : edit.seriesEditor(opened.column, () => setOpened(null))}
          </MarkPopover>
        )}
      </Frame>
      <Caption notes={notes} hint={hint} showTable={showTable} onToggle={() => setShowTable((v) => !v)} />
      {showTable && plot !== null ? <NumbersTable spec={spec} table={table} plot={plot} /> : null}
    </figure>
  );
}

// The notes of the columns a chart reads, like a date order the parser assumed.
function columnNotes(spec: XYSpec, table: DataTable): string[] {
  const ids = [spec.x.column, ...spec.series.flatMap((s) => [s.column, s.x])];
  const seen = new Set<string>();
  return ids.flatMap((id) => {
    const column = id === null ? undefined : findColumn(table, id);
    if (column?.note == null || seen.has(column.id)) return [];
    seen.add(column.id);
    return [`${columnLabel(column)}: ${column.note}`];
  });
}

function nearest(plot: Plot, type: XYSpec["type"], x: number, y: number): Active | null {
  if (type === "scatter") {
    let best: Active | null = null;
    let bestD = HIT * HIT;
    plot.series.forEach((s, si) =>
      s.points.forEach((p, i) => {
        const d = (p.px - x) ** 2 + (p.py - y) ** 2;
        if (d <= bestD) {
          bestD = d;
          best = { kind: "point", series: si, index: i };
        }
      }),
    );
    return best;
  }
  const stops = plot.stops;
  if (stops.length === 0) return null;
  let lo = 0;
  let hi = stops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stops[mid].px < x) lo = mid + 1;
    else hi = mid;
  }
  const stop = lo > 0 && Math.abs(stops[lo - 1].px - x) < Math.abs(stops[lo].px - x) ? lo - 1 : lo;
  return { kind: "row", stop };
}

function moved(plot: Plot, type: XYSpec["type"], cur: Active | null, by: number | "first" | "last"): Active | null {
  if (type === "scatter") {
    const s = cur?.kind === "point" ? cur.series : 0;
    const count = plot.series[s]?.points.length ?? 0;
    if (count === 0) return null;
    const at = cur?.kind === "point" ? cur.index : 0;
    const index = by === "first" ? 0 : by === "last" ? count - 1 : Math.min(count - 1, Math.max(0, at + by));
    return { kind: "point", series: s, index };
  }
  const count = plot.stops.length;
  if (count === 0) return null;
  const at = cur?.kind === "row" ? cur.stop : 0;
  const stop = by === "first" ? 0 : by === "last" ? count - 1 : Math.min(count - 1, Math.max(0, at + by));
  return { kind: "row", stop };
}

// The points the readout lists: every series at the active place along x, or the one dot.
function activePoints(plot: Plot, active: Active): { series: number; point: Point }[] {
  if (active.kind === "point") {
    const p = plot.series[active.series]?.points[active.index];
    return p === undefined ? [] : [{ series: active.series, point: p }];
  }
  const stop = plot.stops[active.stop];
  if (stop === undefined) return [];
  return plot.series.flatMap((s, si) => {
    const p = pointAt(s, stop, REACH);
    return p === undefined ? [] : [{ series: si, point: p }];
  });
}

function HoverMarks({ plot, active }: { plot: Plot; active: Active | null }) {
  if (active === null) return null;
  const { area } = plot;
  const ink = SCREEN_INK;
  const points = activePoints(plot, active);
  const stop = active.kind === "row" ? plot.stops[active.stop] : undefined;
  const isBar = plot.legendMark === "bar";
  return (
    <g pointerEvents="none">
      {stop !== undefined && !isBar ? (
        <line x1={stop.px} x2={stop.px} y1={area.top} y2={area.top + area.height} stroke={ink.tick} strokeWidth={1} shapeRendering="crispEdges" />
      ) : null}
      {isBar
        ? points.flatMap(({ series, point }) =>
            plot.series[series].bars
              .filter((b) => b.row === point.row)
              .map((b) => (
                <rect
                  key={`${series}-${b.row}`}
                  x={b.x - 2}
                  y={b.top - 2}
                  width={b.width + 4}
                  height={b.bottom - b.top + 2}
                  rx={5}
                  fill="none"
                  stroke={ink.title}
                  strokeWidth={1.5}
                />
              )),
          )
        : points.map(({ series, point }) => (
            <circle key={series} cx={point.px} cy={point.py} r={5} fill={ink.series[plot.series[series].color]} stroke={ink.surface} strokeWidth={2} />
          ))}
    </g>
  );
}

function Readout({ plot, spec, table, active, hint = null }: { plot: Plot; spec: XYSpec; table: DataTable; active: Active; hint?: string | null }) {
  const points = activePoints(plot, active);
  const first = points[0];
  if (first === undefined) return null;
  const xColumn = findColumn(table, spec.x.column);
  const own = active.kind === "point" ? spec.series.find((q) => q.column === plot.series[first.series].column)?.x : null;
  const xText = active.kind === "row" ? plot.stops[active.stop]?.label : xLabel(own ? findColumn(table, own) : xColumn, first.point.x);
  const xName = spec.x.title.trim() || (xColumn === undefined ? "x" : columnLabel(xColumn));
  const unit = xColumn?.kind === "date" ? "" : spec.x.unit.trim();
  const px = first.point.px;
  const onLeft = px > plot.area.left + plot.area.width / 2;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-36 rounded-control border border-border-opaque bg-background-raised px-3 py-2 shadow-deep-below"
      style={{ top: plot.area.top, ...(onLeft ? { right: plot.width - px + 12 } : { left: px + 12 }) }}
    >
      <p className="text-paragraph-xsmall text-content-tertiary">
        {spec.type === "bar" ? xText : `${xName} ${xText}${unit && spec.type !== "scatter" ? ` ${unit}` : ""}`}
      </p>
      <ul className="mt-1 grid gap-1">
        {points.map(({ series, point }) => {
          const s = spec.series.find((q) => q.column === plot.series[series].column);
          const error = s?.error ? findColumn(table, s.error) : undefined;
          const e = error?.kind === "number" ? error.values[point.row] : null;
          return (
            <li key={series} className="flex items-center gap-2">
              <SeriesSwatch plotSeries={plot.series[series]} />
              <span className="text-label-small text-content-primary tabular-nums">
                {formatValue(point.y)}
                {e === null || e === undefined ? null : ` ± ${formatValue(Math.abs(e))}`}
              </span>
              <span className="truncate text-paragraph-xsmall text-content-secondary">{plot.series[series].name}</span>
            </li>
          );
        })}
      </ul>
      {hint === null ? null : (
        <p className="mt-2 flex items-center gap-1.5 border-t border-border-opaque pt-2 text-paragraph-xsmall text-content-secondary">
          <PencilIcon className="size-3.5" />
          Click to change {hint}
        </p>
      )}
    </div>
  );
}

function SeriesSwatch({ plotSeries }: { plotSeries: Plot["series"][number] }) {
  const color = SCREEN_INK.series[plotSeries.color];
  return (
    <svg aria-hidden width={12} height={4} className="shrink-0">
      <line x1={0} x2={12} y1={2} y2={2} stroke={color} strokeWidth={2} strokeDasharray={plotSeries.stroke === "dashed" ? "4 2" : DASH.solid} />
    </svg>
  );
}

function NumbersTable({ spec, table, plot }: { spec: XYSpec; table: DataTable; plot: Plot }) {
  const ids = [spec.x.column, ...spec.series.flatMap((s) => [s.x, s.column, s.error])];
  const columns = [...new Set(ids)].flatMap((id) => {
    const c = id === null ? undefined : findColumn(table, id);
    return c === undefined ? [] : [c];
  });
  const rows = [...new Set(plot.series.flatMap((s) => s.points.map((p) => p.row)))].sort((a, b) => a - b);
  return <RowsTable columns={columns} rows={rows} />;
}

function RowsTable({ columns, rows }: { columns: DataColumn[]; rows: number[] }) {
  const shown = rows.slice(0, TABLE_ROWS);
  return (
    <div className="mt-2">
      <div className="max-h-96 overflow-auto rounded-control border border-border-opaque">
        <table className="w-full text-left text-paragraph-xsmall tabular-nums">
          <thead className="sticky top-0 bg-background-secondary">
            <tr>
              {columns.map((c) => (
                <th key={c.id} scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-content-secondary">
                  {columnLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r} className="border-t border-border-opaque">
                {columns.map((c) => (
                  <td key={c.id} className="px-3 py-1.5 whitespace-nowrap text-content-primary">
                    {cellText(c, r, formatValue)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > TABLE_ROWS ? (
        <p className="mt-2 text-paragraph-xsmall text-content-tertiary">
          The first {TABLE_ROWS} of {rows.length.toLocaleString("en-US")} rows. The file has them all.
        </p>
      ) : null}
    </div>
  );
}

// A plate heatmap that fills its container's width. Hover or arrow keys read a well; the
// numbers are the plate as a grid.
function PlateFigure({ spec, table, label, className, edit, hint }: { spec: ScaledSpec; table: DataTable; label: string; className?: string; edit?: FigureEdit; hint?: ReactNode }) {
  const [box, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const gradientId = useId();
  const height = width === null ? 320 : scaledHeight(spec, table, width);
  const editable = edit !== undefined;
  const plot = useMemo(
    () => (width === null ? null : plotScaled(spec, table, { width, height: scaledHeight(spec, table, width) }, { placeholders: editable })),
    [spec, table, width, editable],
  );
  const labels = useMemo(() => (plot === null || !editable ? [] : plateLabels(plot)), [plot, editable]);
  const read = spec.type === "heatmap" ? readLabel(spec, table) : null;
  const notes = [...(read === null ? [] : [`${read}.`]), ...(plot?.notes ?? []), rowsNote(table)].filter((n): n is string => n !== null);

  function point(event: PointerEvent<SVGRectElement>) {
    if (plot === null) return;
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (rect === undefined) return;
    const c = Math.floor((event.clientX - rect.left - plot.plate.left) / plot.pitch);
    const r = Math.floor((event.clientY - rect.top - plot.plate.top) / plot.pitch);
    setActive(r >= 0 && r < plot.rows && c >= 0 && c < plot.columns ? r * plot.columns + c : null);
  }

  function step(event: KeyboardEvent<HTMLDivElement>) {
    if (plot === null) return;
    const move = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[event.key];
    if (move === undefined && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const last = plot.rows * plot.columns - 1;
    setActive((cur) => {
      if (event.key === "Home") return 0;
      if (event.key === "End") return last;
      const at = cur ?? 0;
      const r = Math.min(plot.rows - 1, Math.max(0, Math.floor(at / plot.columns) + (move?.[0] ?? 0)));
      const c = Math.min(plot.columns - 1, Math.max(0, (at % plot.columns) + (move?.[1] ?? 0)));
      return r * plot.columns + c;
    });
  }

  const well = active === null ? undefined : plot?.wells[active];
  return (
    <figure className={cn("min-w-0", className)}>
      <Frame
        box={box}
        height={height}
        label={`${label}. Use the arrow keys to read ${spec.type === "grid" ? "squares" : "wells"}.`}
        onKeyDown={step}
        onFocus={() => setActive((cur) => cur ?? 0)}
        onBlur={() => setActive(null)}
      >
        {plot === null ? null : (
          <PlateSvg plot={plot} ink={SCREEN_INK} gradientId={gradientId} label={label}>
            {well === undefined ? null : (
              plot.shape === "square" ? (
                <rect x={well.cx - plot.pitch / 2 - 1} y={well.cy - plot.pitch / 2 - 1} width={plot.pitch + 2} height={plot.pitch + 2} rx={3} fill="none" stroke={SCREEN_INK.title} strokeWidth={1.5} pointerEvents="none" />
              ) : (
                <circle cx={well.cx} cy={well.cy} r={plot.radius + 2.5} fill="none" stroke={SCREEN_INK.title} strokeWidth={1.5} pointerEvents="none" />
              )
            )}
            <rect
              x={plot.plate.left}
              y={plot.plate.top}
              width={plot.plate.width}
              height={plot.plate.height}
              fill="transparent"
              onPointerMove={point}
              onPointerLeave={() => setActive(null)}
            />
          </PlateSvg>
        )}
        {plot === null || well === undefined ? null : <WellReadout plot={plot} well={well} spec={spec} />}
        {edit === undefined ? null : <EditableLabels labels={labels} edit={edit} />}
      </Frame>
      <Caption notes={notes} hint={hint} showTable={showTable} onToggle={() => setShowTable((v) => !v)} />
      {showTable && plot !== null ? <PlateTable plot={plot} /> : null}
    </figure>
  );
}

function WellReadout({ plot, well, spec }: { plot: PlatePlot; well: PlateWell; spec: ScaledSpec }) {
  const unit = spec.value.unit.trim();
  const onLeft = well.cx > plot.plate.left + plot.plate.width / 2;
  const below = well.cy < plot.plate.top + plot.pitch * 2;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-28 rounded-control border border-border-opaque bg-background-raised px-3 py-2 shadow-deep-below"
      style={{
        top: below ? well.cy + plot.pitch * 0.6 : Math.max(0, well.cy - plot.pitch * 1.6 - 24),
        ...(onLeft ? { right: plot.width - well.cx + plot.pitch * 0.6 } : { left: well.cx + plot.pitch * 0.6 }),
      }}
    >
      <p className="text-paragraph-xsmall text-content-tertiary">
        {well.name}
        {well.label === null ? null : ` · ${well.label}`}
      </p>
      <p className="mt-0.5 text-label-small text-content-primary tabular-nums">
        {well.value === null ? (well.missing ? (spec.type === "grid" ? "No row has this pair" : "Not in the table") : "No number") : `${formatValue(well.value)}${unit ? ` ${unit}` : ""}`}
      </p>
    </div>
  );
}

function PlateTable({ plot }: { plot: PlatePlot }) {
  const rows = Array.from({ length: plot.rows }, (_, r) => plot.wells.slice(r * plot.columns, (r + 1) * plot.columns));
  return (
    <div className="mt-2 max-h-96 overflow-auto rounded-control border border-border-opaque">
      <table className="w-full text-left text-paragraph-xsmall tabular-nums">
        <thead className="sticky top-0 bg-background-secondary">
          <tr>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">Row</span>
            </th>
            {rows[0]?.map((w) => (
              <th key={w.column} scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-content-secondary">
                {plot.columnNames[w.column]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((wells, r) => (
            <tr key={r} className="border-t border-border-opaque">
              <th scope="row" className="px-3 py-1.5 font-medium text-content-secondary">
                {plot.rowNames[r]}
              </th>
              {wells.map((w) => (
                <td key={w.name} title={w.label ?? undefined} className="px-3 py-1.5 whitespace-nowrap text-content-primary">
                  {w.value === null ? "" : formatValue(w.value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
