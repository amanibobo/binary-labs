"use client";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { isHeatmap, type ChartSpec, type HeatmapSpec, type XYSpec } from "@/lib/charts";
import { formatValue, plotChart, pointAt, xLabel, type Plot, type Point } from "@/lib/chart-geometry";
import { cellText, columnLabel, findColumn, rowsNote, type DataColumn, type DataTable } from "@/lib/data-tables";
import { plateHeight, plotPlate, readLabel, type PlatePlot, type PlateWell } from "@/lib/plate-geometry";
import { rowLetter } from "@/lib/plates";
import { Button } from "../ui/button";
import { ChartSvg, DASH, PlateSvg, SCREEN_INK } from "./chart-svg";

const HIT = 24;
// How far from the pointer a series with its own x still counts as there.
const REACH = 12;
const TABLE_ROWS = 500;

export function chartHeight(width: number): number {
  return Math.round(Math.min(460, Math.max(260, width * 0.58)));
}

// A chart that fills its container's width, with a readout on hover and focus, and the numbers
// it draws one click away.
export function ChartFigure({ spec, table, label, className }: { spec: ChartSpec; table: DataTable; label: string; className?: string }) {
  return isHeatmap(spec) ? (
    <PlateFigure spec={spec} table={table} label={label} className={className} />
  ) : (
    <XYFigure spec={spec} table={table} label={label} className={className} />
  );
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number | null] {
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

function Caption({ notes, showTable, onToggle }: { notes: string[]; showTable: boolean; onToggle: () => void }) {
  return (
    <figcaption className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 text-paragraph-xsmall text-content-tertiary">
        {notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </div>
      <Button variant="tertiary" size="compact" className="-mr-3 text-content-secondary" aria-expanded={showTable} onClick={onToggle}>
        {showTable ? "Hide the numbers" : "Show the numbers"}
      </Button>
    </figcaption>
  );
}

function Frame({
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
      onFocus={onFocus}
      onBlur={onBlur}
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

function XYFigure({ spec, table, label, className }: { spec: XYSpec; table: DataTable; label: string; className?: string }) {
  const [box, width] = useWidth();
  const [active, setActive] = useState<Active | null>(null);
  const [showTable, setShowTable] = useState(false);
  const clipId = useId();

  const plot = useMemo(() => (width === null ? null : plotChart(spec, table, { width, height: chartHeight(width) })), [spec, table, width]);
  const notes = [...(plot?.notes ?? []), ...columnNotes(spec, table), rowsNote(table)].filter((n): n is string => n !== null);

  function point(event: PointerEvent<SVGRectElement>) {
    if (plot === null) return;
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (rect === undefined) return;
    setActive(nearest(plot, spec.type, event.clientX - rect.left, event.clientY - rect.top));
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
            <rect
              x={plot.area.left}
              y={plot.area.top}
              width={plot.area.width}
              height={plot.area.height}
              fill="transparent"
              onPointerMove={point}
              onPointerLeave={() => setActive(null)}
            />
          </ChartSvg>
        )}
        {plot === null || active === null ? null : <Readout plot={plot} spec={spec} table={table} active={active} />}
      </Frame>
      <Caption notes={notes} showTable={showTable} onToggle={() => setShowTable((v) => !v)} />
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

function Readout({ plot, spec, table, active }: { plot: Plot; spec: XYSpec; table: DataTable; active: Active }) {
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
function PlateFigure({ spec, table, label, className }: { spec: HeatmapSpec; table: DataTable; label: string; className?: string }) {
  const [box, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const gradientId = useId();
  const height = width === null ? 320 : plateHeight(spec, width);
  const plot = useMemo(() => (width === null ? null : plotPlate(spec, table, { width, height: plateHeight(spec, width) })), [spec, table, width]);
  const read = readLabel(spec, table);
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
        label={`${label}. Use the arrow keys to read wells.`}
        onKeyDown={step}
        onFocus={() => setActive((cur) => cur ?? 0)}
        onBlur={() => setActive(null)}
      >
        {plot === null ? null : (
          <PlateSvg plot={plot} ink={SCREEN_INK} gradientId={gradientId} label={label}>
            {well === undefined ? null : (
              <circle cx={well.cx} cy={well.cy} r={plot.radius + 2.5} fill="none" stroke={SCREEN_INK.title} strokeWidth={1.5} pointerEvents="none" />
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
      </Frame>
      <Caption notes={notes} showTable={showTable} onToggle={() => setShowTable((v) => !v)} />
      {showTable && plot !== null ? <PlateTable plot={plot} /> : null}
    </figure>
  );
}

function WellReadout({ plot, well, spec }: { plot: PlatePlot; well: PlateWell; spec: HeatmapSpec }) {
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
        {well.value === null ? (well.missing ? "Not in the table" : "No number") : `${formatValue(well.value)}${unit ? ` ${unit}` : ""}`}
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
                {w.column + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((wells, r) => (
            <tr key={r} className="border-t border-border-opaque">
              <th scope="row" className="px-3 py-1.5 font-medium text-content-secondary">
                {rowLetter(r)}
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
