import { axisText, splitAxisText } from "./chart-guide";
import { isXY, MAX_SERIES, nextStyle, type ChartSpec, type HeatmapSpec, type Series, type SeriesColor, type Stroke, type XYSpec } from "./charts";
import { findColumn, spreadFor, type DataColumn, type DataTable } from "./data-tables";
import type { ColumnId } from "./ids";

// The builder's edits as pure functions of a spec and its table, shared by the panel and the
// words and marks edited on the chart itself.

// A label edited in place: an axis title, the plate's scale, or a series' name.
export type LabelTarget = { kind: "x" } | { kind: "y" } | { kind: "value" } | { kind: "series"; column: ColumnId };

// A column's name is what an axis title starts as, until someone types their own.
function isAutoTitle(title: string, table: DataTable): boolean {
  return title.trim() === "" || table.columns.some((c) => c.name === title.trim());
}

// Axis titles that still carry a column's name follow the columns: x's own name, and y's from
// the one measured column (blank once there are several, so the legend names them).
export function withAxisFrom(spec: XYSpec, table: DataTable): XYSpec {
  const x = findColumn(table, spec.x.column);
  const measured = spec.series.map((s) => findColumn(table, s.column)).filter((c): c is DataColumn => c !== undefined);
  const only = measured.length === 1 ? measured[0] : undefined;
  const units = new Set(measured.map((c) => c.unit ?? ""));
  const y = isAutoTitle(spec.y.title, table)
    ? { ...spec.y, title: only?.name ?? "", unit: only !== undefined ? (only.unit ?? "") : units.size === 1 ? [...units][0] : "" }
    : spec.y;
  return {
    ...spec,
    x: x !== undefined && isAutoTitle(spec.x.title, table) ? { ...spec.x, title: x.name, unit: x.kind === "number" ? (x.unit ?? "") : "" } : spec.x,
    y,
  };
}

// Adds a measured column with the next free style and its spreads as error bars when the
// table has them, or returns the spec as it is when the chart is full or has it already.
export function addSeries(spec: XYSpec, table: DataTable, column: DataColumn): XYSpec {
  if (column.kind !== "number" || column.id === spec.x.column || spec.series.some((s) => s.column === column.id)) return spec;
  if (spec.series.length >= MAX_SERIES[spec.type]) return spec;
  const errorBars = spec.series.some((s) => s.error !== null);
  const error = errorBars || spec.series.length === 0 ? (spreadFor(table, column)?.id ?? null) : null;
  const series: Series = { column: column.id, name: column.name, ...nextStyle(spec.series, spec.type), error, x: null };
  return withAxisFrom({ ...spec, series: [...spec.series, series] }, table);
}

export function removeSeries(spec: XYSpec, table: DataTable, column: ColumnId): XYSpec {
  if (spec.series.length <= 1) return spec;
  return withAxisFrom({ ...spec, series: spec.series.filter((s) => s.column !== column) }, table);
}

// A new column along the bottom. A measured column moved there stops being measured, and a
// series' own x has to stay the same kind as the chart's.
export function setBottom(spec: XYSpec, table: DataTable, column: DataColumn): XYSpec {
  const series = spec.series
    .filter((s) => s.column !== column.id)
    .map((s) => ({ ...s, x: s.x === column.id || findColumn(table, s.x ?? column.id)?.kind !== column.kind ? null : s.x }));
  if (series.length === 0) return spec;
  return withAxisFrom({ ...spec, x: { ...spec.x, column: column.id, min: null, max: null }, series }, table);
}

export function editSeries(spec: XYSpec, column: ColumnId, f: (s: Series) => Series): XYSpec {
  return { ...spec, series: spec.series.map((s) => (s.column === column ? f(s) : s)) };
}

// A series takes a color and line style; one that already had them takes the other's old ones,
// so no two series ever look alike.
export function restyle(spec: XYSpec, column: ColumnId, style: { color: SeriesColor; stroke: Stroke }): XYSpec {
  const own = spec.series.find((s) => s.column === column);
  if (own === undefined) return spec;
  const stroke = spec.type === "line" ? style.stroke : "solid";
  return {
    ...spec,
    series: spec.series.map((s) => {
      if (s.column === column) return { ...s, color: style.color, stroke };
      if (s.color === style.color && s.stroke === stroke) return { ...s, color: own.color, stroke: own.stroke };
      return s;
    }),
  };
}

// The error bars a chart could show from the table's spreads (SD, SEM), one per measured column
// that has them; empty when it has none.
export function spreadsFor(spec: XYSpec, table: DataTable): { column: ColumnId; error: ColumnId }[] {
  return spec.series.flatMap((s) => {
    const c = findColumn(table, s.column);
    const spread = c === undefined ? null : spreadFor(table, c);
    return spread === null ? [] : [{ column: s.column, error: spread.id }];
  });
}

// "Show how much your repeats vary": on gives each series its spreads; off takes every error
// bar away, including ones picked by hand.
export function setErrorBars(spec: XYSpec, table: DataTable, on: boolean): XYSpec {
  const spreads = new Map(spreadsFor(spec, table).map((s) => [s.column, s.error]));
  return { ...spec, series: spec.series.map((s) => ({ ...s, error: on ? (spreads.get(s.column) ?? s.error) : null })) };
}

// The text a label edits in place, units included.
export function labelText(spec: ChartSpec, target: LabelTarget): string {
  if (!isXY(spec) && spec.type !== "heatmap") {
    if (target.kind === "x") return "unit" in spec.x ? axisText(spec.x.title, spec.x.unit) : spec.x.title;
    if (target.kind === "y") return "unit" in spec.y ? axisText(spec.y.title, spec.y.unit) : spec.y.title;
    return "";
  }
  switch (target.kind) {
    case "x":
      return spec.type === "heatmap" ? "" : axisText(spec.x.title, spec.x.unit);
    case "y":
      return spec.type === "heatmap" ? "" : axisText(spec.y.title, spec.y.unit);
    case "value":
      return spec.type === "heatmap" ? axisText(spec.value.title, spec.value.unit) : "";
    case "series":
      return spec.type === "heatmap" ? "" : (spec.series.find((s) => s.column === target.column)?.name ?? "");
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

// A label renamed in place. "Absorbance (AU)" sets an axis title and its unit; a date axis has
// no unit. A series can't be left without a name, so a blank one keeps the old.
export function rename(spec: ChartSpec, table: DataTable, target: LabelTarget, text: string): ChartSpec {
  const parts = splitAxisText(text.slice(0, 80));
  const unit = parts.unit.slice(0, 24);
  if (spec.type === "heatmap") return target.kind === "value" ? renameValue(spec, parts.title, unit) : spec;
  if (!isXY(spec)) {
    // A chart of repeats: its two axis titles. A bar chart of groups names its bottom only.
    const whole = text.trim().slice(0, 80);
    if (target.kind === "x") {
      if (spec.type === "groups") return { ...spec, x: { title: whole } };
      if (spec.type === "histogram") return { ...spec, x: { ...spec.x, title: parts.title, unit } };
      return { ...spec, x: { ...spec.x, title: parts.title, unit } };
    }
    if (target.kind === "y") {
      if (spec.type === "histogram") return { ...spec, y: { title: whole } };
      return { ...spec, y: { ...spec.y, title: parts.title, unit } };
    }
    return spec;
  }
  switch (target.kind) {
    case "x": {
      const isDate = findColumn(table, spec.x.column)?.kind === "date";
      return { ...spec, x: { ...spec.x, title: isDate ? text.trim().slice(0, 80) : parts.title, unit: isDate ? "" : unit } };
    }
    case "y":
      return { ...spec, y: { ...spec.y, title: parts.title, unit } };
    case "series": {
      const name = text.trim().slice(0, 80);
      return name === "" ? spec : editSeries(spec, target.column, (s) => ({ ...s, name }));
    }
    case "value":
      return spec;
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

function renameValue(spec: HeatmapSpec, title: string, unit: string): HeatmapSpec {
  return { ...spec, value: { ...spec.value, title, unit } };
}
