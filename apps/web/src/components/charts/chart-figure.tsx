"use client";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";
import type { ChartSpec } from "@/lib/charts";
import { formatValue, plotChart, type Plot, type Point } from "@/lib/chart-geometry";
import { columnLabel, findColumn, rowsNote, type DataTable } from "@/lib/data-tables";
import { Button } from "../ui/button";
import { ChartSvg, SCREEN_INK } from "./chart-svg";

const HIT = 24;
const TABLE_ROWS = 500;

export function chartHeight(width: number): number {
  return Math.round(Math.min(460, Math.max(260, width * 0.58)));
}

// What the hover layer points at: a row along x (line and bar), or one dot (scatter).
type Active = { kind: "row"; stop: number } | { kind: "point"; series: number; index: number };

// A chart that fills its container's width, with a crosshair and readout on hover and focus,
// and the numbers it draws one click away.
export function ChartFigure({ spec, table, label, className }: { spec: ChartSpec; table: DataTable; label: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [showTable, setShowTable] = useState(false);
  const clipId = useId();

  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const plot = useMemo(() => (width === null ? null : plotChart(spec, table, { width, height: chartHeight(width) })), [spec, table, width]);
  const notes = [...(plot?.notes ?? []), rowsNote(table)].filter((n): n is string => n !== null);

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
      <div
        ref={box}
        tabIndex={0}
        onKeyDown={step}
        onFocus={() => setActive((cur) => cur ?? (plot === null ? null : moved(plot, spec.type, null, "first")))}
        onBlur={() => setActive(null)}
        aria-label={`${label}. Use the arrow keys to read values.`}
        className="relative w-full rounded-control focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-accent"
        style={{ height: width === null ? 320 : chartHeight(width) }}
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
      </div>
      <figcaption className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 text-paragraph-xsmall text-content-tertiary">
          {notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
        <Button variant="tertiary" size="compact" className="-mr-3 text-content-secondary" aria-expanded={showTable} onClick={() => setShowTable((v) => !v)}>
          {showTable ? "Hide the numbers" : "Show the numbers"}
        </Button>
      </figcaption>
      {showTable && plot !== null ? <NumbersTable spec={spec} table={table} plot={plot} /> : null}
    </figure>
  );
}

function nearest(plot: Plot, type: ChartSpec["type"], x: number, y: number): Active | null {
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

function moved(plot: Plot, type: ChartSpec["type"], cur: Active | null, by: number | "first" | "last"): Active | null {
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

// The points the readout lists: every series at the active row, or the one dot.
function activePoints(plot: Plot, active: Active): { series: number; point: Point }[] {
  if (active.kind === "point") {
    const p = plot.series[active.series]?.points[active.index];
    return p === undefined ? [] : [{ series: active.series, point: p }];
  }
  const row = plot.stops[active.stop]?.row;
  return plot.series.flatMap((s, si) => {
    const p = s.points.find((q) => q.row === row);
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

function Readout({ plot, spec, table, active }: { plot: Plot; spec: ChartSpec; table: DataTable; active: Active }) {
  const points = activePoints(plot, active);
  const first = points[0];
  if (first === undefined) return null;
  const xColumn = findColumn(table, spec.x.column);
  const xText = active.kind === "row" ? plot.stops[active.stop]?.label : formatValue(first.point.x);
  const xName = spec.x.title.trim() || (xColumn === undefined ? "x" : columnLabel(xColumn));
  const unit = spec.x.unit.trim();
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
              <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: SCREEN_INK.series[plot.series[series].color] }} />
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

function NumbersTable({ spec, table, plot }: { spec: ChartSpec; table: DataTable; plot: Plot }) {
  const x = findColumn(table, spec.x.column);
  const columns = [x, ...spec.series.flatMap((s) => [findColumn(table, s.column), s.error === null ? undefined : findColumn(table, s.error)])].filter(
    (c): c is NonNullable<typeof c> => c !== undefined,
  );
  const rows = [...new Set(plot.stops.map((s) => s.row))].sort((a, b) => a - b);
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
                {columns.map((c) => {
                  const v = c.values[r];
                  return (
                    <td key={c.id} className="px-3 py-1.5 whitespace-nowrap text-content-primary">
                      {v === null || v === undefined ? "" : typeof v === "number" ? formatValue(v) : v}
                    </td>
                  );
                })}
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
