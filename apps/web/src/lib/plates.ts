import { z } from "zod";
import { findColumn, type AxisColumn, type DataTable, type NumberColumn, type TextColumn } from "./data-tables";
import { ColumnId } from "./ids";

// 96- and 384-well plates in a table, for the plate heatmap (decisions.md, "plate heatmaps").
// A plate comes three ways: as a grid (row letters down the side, column numbers across, the
// parser keeps a blank corner's letters), one row per well ("Well, Value"), or a kinetic read
// with a column per well and a row per read.

export const PLATE_SIZES = [96, 384] as const;
export const PlateSize = z.union([z.literal(96), z.literal(384)]);
export type PlateSize = z.infer<typeof PlateSize>;

export const PLATE_SHAPE = { 96: { rows: 8, columns: 12 }, 384: { rows: 16, columns: 24 } } satisfies Record<
  PlateSize,
  { rows: number; columns: number }
>;

const ROW_LETTERS = "ABCDEFGHIJKLMNOP";

// Where a chart reads its wells from. A grid and a list name their columns, so a parse that
// moves them is caught; a read names the table row of the time point shown.
export const PlateSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grid"), rows: ColumnId }),
  z.object({ kind: z.literal("wells"), well: ColumnId, value: ColumnId }),
  z.object({ kind: z.literal("read"), row: z.number().int().nonnegative().max(1_000_000) }),
]);
export type PlateSource = z.infer<typeof PlateSource>;

export type Well = { row: number; column: number };

// "A1", "a01", "P24" to a zero-based row and column; anything else is null.
export function parseWell(text: string): Well | null {
  const m = /^\s*([A-Pa-p])\s*0?(\d{1,2})\s*$/.exec(text);
  if (m === null) return null;
  const column = Number(m[2]);
  if (column < 1 || column > 24) return null;
  return { row: ROW_LETTERS.indexOf(m[1].toUpperCase()), column: column - 1 };
}

export function wellName(well: Well): string {
  return `${ROW_LETTERS[well.row]}${well.column + 1}`;
}

export function rowLetter(row: number): string {
  return ROW_LETTERS[row] ?? "?";
}

function sizeFor(wells: readonly Well[]): PlateSize {
  return wells.some((w) => w.row >= 8 || w.column >= 12) ? 384 : 96;
}

// What a table holds, plate-wise.
export type PlateLayout =
  | { kind: "grid"; size: PlateSize; rows: TextColumn; columns: { column: NumberColumn; index: number }[] }
  | { kind: "wells"; size: PlateSize; well: TextColumn; values: NumberColumn[]; label: TextColumn | null }
  | { kind: "read"; size: PlateSize; wells: { column: NumberColumn; well: Well }[]; time: AxisColumn | null };

function gridLayout(table: DataTable): PlateLayout | null {
  for (const letters of table.columns) {
    if (letters.kind !== "text") continue;
    const values = letters.values.filter((v): v is string => v !== null).map((v) => v.trim().toUpperCase());
    if (values.length < 2 || !values.every((v, i) => v === ROW_LETTERS[i])) continue;
    const columns = table.columns.flatMap((c) => {
      const n = Number(c.name);
      return c.kind === "number" && Number.isInteger(n) && n >= 1 && n <= 24 ? [{ column: c, index: n - 1 }] : [];
    });
    if (columns.length < 2) continue;
    const size: PlateSize = values.length > 8 || columns.some((c) => c.index >= 12) ? 384 : 96;
    return { kind: "grid", size, rows: letters, columns };
  }
  return null;
}

function wellsLayout(table: DataTable): PlateLayout | null {
  const values = table.columns.filter((c): c is NumberColumn => c.kind === "number");
  if (values.length === 0) return null;
  for (const column of table.columns) {
    if (column.kind !== "text") continue;
    const filled = column.values.filter((v): v is string => v !== null);
    const wells = filled.map(parseWell).filter((w): w is Well => w !== null);
    // Most of the table, not a fraction list beside a long trace (AKTA's fractions are wells too).
    if (wells.length < 8 || wells.length < filled.length * 0.9 || filled.length * 2 < table.rows) continue;
    const label = table.columns.find((c): c is TextColumn => c.kind === "text" && c.id !== column.id) ?? null;
    return { kind: "wells", size: sizeFor(wells), well: column, values, label };
  }
  return null;
}

function readLayout(table: DataTable): PlateLayout | null {
  const wells = table.columns.flatMap((c) => {
    const well = c.kind === "number" ? parseWell(c.name) : null;
    return c.kind === "number" && well !== null ? [{ column: c, well }] : [];
  });
  if (wells.length < 8) return null;
  const isWell = new Set(wells.map((w) => w.column.id));
  const time = table.columns.find((c): c is AxisColumn => (c.kind === "number" || c.kind === "date") && !isWell.has(c.id)) ?? null;
  return { kind: "read", size: sizeFor(wells.map((w) => w.well)), wells, time };
}

// The plate in a table, or null when it isn't one.
export function plateLayout(table: DataTable): PlateLayout | null {
  return gridLayout(table) ?? wellsLayout(table) ?? readLayout(table);
}

export type PlateCell = Well & { name: string; value: number | null; label: string | null };

// Every well the source names, with its value; wells it doesn't name are left out.
export function plateCells(table: DataTable, layout: PlateLayout, source: PlateSource): PlateCell[] {
  const cells: PlateCell[] = [];
  const add = (well: Well, value: number | null, label: string | null) => cells.push({ ...well, name: wellName(well), value, label });
  switch (source.kind) {
    case "grid": {
      if (layout.kind !== "grid") return [];
      layout.rows.values.forEach((letter, r) => {
        const row = letter === null ? -1 : ROW_LETTERS.indexOf(letter.trim().toUpperCase());
        if (row < 0) return;
        for (const { column, index } of layout.columns) add({ row, column: index }, column.values[r] ?? null, null);
      });
      return cells;
    }
    case "wells": {
      const wellColumn = findColumn(table, source.well);
      const valueColumn = findColumn(table, source.value);
      if (wellColumn?.kind !== "text" || valueColumn?.kind !== "number") return [];
      const label = layout.kind === "wells" ? layout.label : null;
      wellColumn.values.forEach((text, r) => {
        const well = text === null ? null : parseWell(text);
        if (well !== null) add(well, valueColumn.values[r] ?? null, label?.values[r] ?? null);
      });
      return cells;
    }
    case "read": {
      if (layout.kind !== "read") return [];
      for (const { column, well } of layout.wells) add(well, column.values[source.row] ?? null, null);
      return cells;
    }
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

// The source a new plate chart starts from: the grid, the first value column, or the last read.
export function startingSource(layout: PlateLayout, table: DataTable): PlateSource {
  switch (layout.kind) {
    case "grid":
      return { kind: "grid", rows: layout.rows.id };
    case "wells":
      return { kind: "wells", well: layout.well.id, value: layout.values[0].id };
    case "read":
      return { kind: "read", row: Math.max(0, table.rows - 1) };
    default: {
      const _exhaustive: never = layout;
      return _exhaustive;
    }
  }
}
