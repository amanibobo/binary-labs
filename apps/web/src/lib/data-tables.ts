import { z } from "zod";
import { ColumnId } from "./ids";

// A file's full tables as the worker parsed them (workers/src/bl_worker/tables.py), read from
// <lab_id>/tables/<sha256>.json in the object store. One column per spreadsheet column, with
// its values in row order: null for a blank cell, or for a cell in a number column that held
// text (counted in `invalid`).

const Common = { id: ColumnId, name: z.string(), invalid: z.number().int().nonnegative() };

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

export const DataColumn = z.discriminatedUnion("kind", [NumberColumn, TextColumn]);
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

const count = new Intl.NumberFormat("en-US");

// Said under the chart when the worker kept only the first rows of a big sheet.
export function rowsNote(table: DataTable): string | null {
  if (!table.truncated) return null;
  const kept = count.format(table.rows);
  return table.rowsInFile === null ? `First ${kept} rows.` : `First ${kept} rows of ${count.format(table.rowsInFile)}.`;
}

// The table a chart opens on: the one with the most cells, which is the data and not a preamble.
export function mainTable(doc: DataTables): DataTable | null {
  let best: DataTable | null = null;
  for (const t of doc.tables) {
    if (best === null || t.rows * t.columns.length > best.rows * best.columns.length) best = t;
  }
  return best;
}
