import type { DataColumn, DataTable } from "./data-tables";

// How much of a data sheet the opened row shows: a small corner of the table, then a bigger
// one after "Show more". The instrument's header lines are the table's notes, kept apart.
export const PREVIEW_SIZES = {
  short: { rows: 5, columns: 5 },
  long: { rows: 30, columns: 24 },
} as const;

export type PreviewSize = keyof typeof PREVIEW_SIZES;

export type TableSlice = {
  columns: DataColumn[];
  rows: number;
  // Whether the sheet holds more than this slice shows.
  cut: boolean;
  // "31 rows · 98 columns", the size of the whole sheet as read.
  size: string;
};

const count = new Intl.NumberFormat("en-US");
const plural = (n: number, one: string, many: string) => `${count.format(n)} ${n === 1 ? one : many}`;

export function tableSlice({ table, size }: { table: DataTable; size: PreviewSize }): TableSlice {
  const limit = PREVIEW_SIZES[size];
  const rowsInFile = table.rowsInFile ?? table.rows;
  return {
    columns: table.columns.slice(0, limit.columns),
    rows: Math.min(table.rows, limit.rows),
    cut: table.rows > limit.rows || table.columns.length > limit.columns || table.truncated,
    size: `${plural(rowsInFile, "row", "rows")} · ${plural(table.columns.length, "column", "columns")}`,
  };
}
