import { z } from "zod";
import { ColumnId } from "./ids";

// A file's full tables as the worker parsed them (workers/src/bl_worker/tables.py), read from
// <lab_id>/tables/<sha256>.json in the object store. One column per spreadsheet column, with
// its values in row order: null for a blank cell, or for a cell in a number or date column that
// held something else (counted in `invalid`).

const Common = {
  id: ColumnId,
  name: z.string(),
  invalid: z.number().int().nonnegative(),
  // How the column was read, when the reader should know: a date order that was assumed. Tables
  // parsed before parser version 2 have none.
  note: z.string().nullable().default(null),
};

export const NumberColumn = z.object({
  ...Common,
  kind: z.literal("number"),
  unit: z.string().nullable(),
  values: z.array(z.number().nullable()),
});
export type NumberColumn = z.infer<typeof NumberColumn>;

export const TextColumn = z.object({
  ...Common,
  kind: z.literal("text"),
  unit: z.null(),
  values: z.array(z.string().nullable()),
});
export type TextColumn = z.infer<typeof TextColumn>;

// Milliseconds since 1970 of the wall-clock time as the file wrote it, so a chart prints what
// the instrument printed and never shifts with the reader's time zone (formatted in UTC).
export const DateColumn = z.object({
  ...Common,
  kind: z.literal("date"),
  unit: z.null(),
  values: z.array(z.number().nullable()),
  // Whether any value has a time of day; a column of days prints days.
  time: z.boolean(),
});
export type DateColumn = z.infer<typeof DateColumn>;

export const DataColumn = z.discriminatedUnion("kind", [NumberColumn, TextColumn, DateColumn]);
export type DataColumn = z.infer<typeof DataColumn>;

export const DataTable = z.object({
  // The sheet's name, or "Table 1" for a CSV; what charts.sheet stores.
  name: z.string().min(1),
  sheet: z.string(),
  notes: z.array(z.string()),
  rows: z.number().int().nonnegative(),
  truncated: z.boolean(),
  rowsInFile: z.number().int().nonnegative().nullable(),
  columns: z.array(DataColumn),
});
export type DataTable = z.infer<typeof DataTable>;

export const DataTables = z.object({
  version: z.number().int().positive(),
  cellLimit: z.number().int().positive(),
  tables: z.array(DataTable),
});
export type DataTables = z.infer<typeof DataTables>;

// What GET /api/tables/<sha256> answers. "missing" is a spreadsheet indexed before charts
// existed: the builder asks for it, then polls.
export const TableState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing") }),
  z.object({ state: z.literal("waiting") }),
  z.object({ state: z.literal("failed"), error: z.string() }),
  z.object({ state: z.literal("ready"), tables: DataTables }),
]);
export type TableState = z.infer<typeof TableState>;

export function columnLabel(column: DataColumn): string {
  return column.unit === null || column.unit === "" ? column.name : `${column.name} (${column.unit})`;
}

export function findColumn(table: DataTable, id: ColumnId): DataColumn | undefined {
  return table.columns.find((c) => c.id === id);
}

export function numberColumns(table: DataTable): NumberColumn[] {
  return table.columns.filter((c): c is NumberColumn => c.kind === "number");
}

// What can run along a line or scatter chart's x: numbers, or dates on a time axis.
export type AxisColumn = NumberColumn | DateColumn;

export function axisColumns(table: DataTable): AxisColumn[] {
  return table.columns.filter((c): c is AxisColumn => c.kind === "number" || c.kind === "date");
}

const dateParts = { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" } as const;
const dayFormat = new Intl.DateTimeFormat("en-US", dateParts);
const minuteFormat = new Intl.DateTimeFormat("en-US", { ...dateParts, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const secondFormat = new Intl.DateTimeFormat("en-US", { ...dateParts, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

// A date as a readout or the numbers table prints it: "Nov 3, 2026", with the time when the
// column has times, and seconds when the value has them.
export function formatDate(ms: number, withTime: boolean): string {
  if (!withTime) return dayFormat.format(ms);
  if (ms % 60_000 === 0) return minuteFormat.format(ms);
  const text = secondFormat.format(ms);
  const rest = Math.round(((ms % 1000) + 1000) % 1000);
  return rest === 0 ? text : `${text}.${String(rest).padStart(3, "0")}`;
}

// One cell as the numbers table prints it.
export function cellText(column: DataColumn, row: number, formatNumber: (v: number) => string): string {
  switch (column.kind) {
    case "number": {
      const v = column.values[row];
      return v === null || v === undefined ? "" : formatNumber(v);
    }
    case "date": {
      const v = column.values[row];
      return v === null || v === undefined ? "" : formatDate(v, column.time);
    }
    case "text":
      return column.values[row] ?? "";
    default: {
      const _exhaustive: never = column;
      return _exhaustive;
    }
  }
}

const count = new Intl.NumberFormat("en-US");

// Said under the chart when the worker kept only the first rows of a big sheet.
export function rowsNote(table: DataTable): string | null {
  if (!table.truncated) return null;
  const kept = count.format(table.rows);
  return table.rowsInFile === null ? `First ${kept} rows.` : `First ${kept} rows of ${count.format(table.rowsInFile)}.`;
}

// The table a chart opens on: the first one with at least a quarter of the biggest one's cells.
// A workbook opens on its first sheet, as Excel does, but a few lines a blank row split off
// above the data are passed over.
export function mainTable(doc: DataTables): DataTable | null {
  const cells = (t: DataTable) => t.rows * t.columns.length;
  const most = Math.max(0, ...doc.tables.map(cells));
  return doc.tables.find((t) => cells(t) * 4 >= most) ?? null;
}

// What a column's name says it holds, for a chart's first choices (lib/chart-guide.ts). Words
// are matched whole, so "SD" is found in "A595 SD" but not in "SDS".
const word = (words: string) => new RegExp(`(^|[^\\p{L}])(${words})(?=$|[^\\p{L}])`, "iu");
const SPREAD = word("sd|s\\.d\\.|sem|s\\.e\\.m\\.|se|stdev|std\\.? ?dev|st\\.? ?dev|standard deviation|standard error|std\\.? ?err(?:or)?|error|ci|±");
const MEAN = word("mean|average|avg");
const REPEAT = /(^|[^\p{L}])(rep|replicate|repeat|trial)\.?\s*\d+/iu;
const BOOKKEEPING = /^(#|no\.?|id|index|row|order)$|dilution|factor/i;

// A column of spreads (SD, SEM, a confidence interval): error bars, not a reading.
export function isSpreadColumn(column: DataColumn): boolean {
  return column.kind === "number" && SPREAD.test(column.name);
}

export function isMeanColumn(column: DataColumn): boolean {
  return column.kind === "number" && MEAN.test(column.name);
}

// A column that numbers or scales the rows rather than measuring them: a dilution, an index.
export function isBookkeepingColumn(column: DataColumn): boolean {
  return BOOKKEEPING.test(column.name.trim());
}

// How many repeats a table records side by side ("Rep 1", "Rep 2", "Rep 3"); 0 when it doesn't.
export function repeatCount(table: DataTable): number {
  const n = table.columns.filter((c) => c.kind === "number" && REPEAT.test(c.name)).length;
  return n >= 2 ? n : 0;
}

// A name with the words that make it a mean or a spread taken out, so "A280 mean" and
// "A280 SD" are seen as one measurement.
function stem(name: string): string {
  return name
    .replace(new RegExp(SPREAD.source, "giu"), " ")
    .replace(new RegExp(MEAN.source, "giu"), " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

// The column of spreads that goes with a measured column: the one named like it, or the
// table's only one when the measured column is a mean. Units agree when both have one.
export function spreadFor(table: DataTable, measured: DataColumn): NumberColumn | null {
  if (measured.kind !== "number" || isSpreadColumn(measured)) return null;
  const spreads = numberColumns(table).filter(
    (c) => c.id !== measured.id && isSpreadColumn(c) && (c.unit === null || measured.unit === null || c.unit === measured.unit),
  );
  const named = spreads.find((c) => stem(c.name) === stem(measured.name));
  if (named !== undefined) return named;
  return spreads.length === 1 && isMeanColumn(measured) ? spreads[0] : null;
}
