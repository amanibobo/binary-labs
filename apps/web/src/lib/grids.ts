import { formatValue } from "./numbers";
import { findColumn, formatDate, isBookkeepingColumn, isSpreadColumn, numberColumns, type DataColumn, type DataTable } from "./data-tables";
import type { ColumnId } from "./ids";

// A heatmap of any two columns that sort the rows into kinds (decisions.md, "charts round 2"):
// one runs down the side, one across, and each square is the mean of a number column over the
// rows that have that pair, such as a cell line by a day. Pure, so the builder, the figure and
// the export agree.

// Kinds a side can hold before the squares get too small to read.
export const GRID_MAX = 40;

const REPEAT_INDEX = /^(#|no\.?|n|rep|replicate|repeat|well|trial|sample no\.?)$/i;

export type Categories = { names: string[]; index: (number | null)[] };

// The kinds a column sorts its rows into, in the order a reader expects: words as the sheet
// first lists them, numbers and dates from low to high.
export function categories(column: DataColumn): Categories {
  const labelOf = (r: number): { key: string; sort: number | null; name: string } | null => {
    switch (column.kind) {
      case "text": {
        const v = column.values[r]?.trim();
        return v === undefined || v === "" ? null : { key: v, sort: null, name: v };
      }
      case "number": {
        const v = column.values[r];
        return v === null || v === undefined ? null : { key: String(v), sort: v, name: column.unit ? `${formatValue(v)} ${column.unit}` : formatValue(v) };
      }
      case "date": {
        const v = column.values[r];
        return v === null || v === undefined ? null : { key: String(v), sort: v, name: formatDate(v, column.time) };
      }
      default: {
        const _exhaustive: never = column;
        return _exhaustive;
      }
    }
  };
  const seen = new Map<string, { sort: number | null; name: string; first: number }>();
  const keys: (string | null)[] = column.values.map((_, r) => {
    const l = labelOf(r);
    if (l === null) return null;
    if (!seen.has(l.key)) seen.set(l.key, { sort: l.sort, name: l.name, first: seen.size });
    return l.key;
  });
  const order = [...seen.entries()].sort(([, a], [, b]) => (a.sort !== null && b.sort !== null ? a.sort - b.sort : a.first - b.first));
  const at = new Map(order.map(([key], i) => [key, i]));
  return { names: order.map(([, v]) => v.name), index: keys.map((k) => (k === null ? null : (at.get(k) ?? null))) };
}

// A column that sorts the rows into between 2 and GRID_MAX kinds, with some kind used twice.
export function isCategoryColumn(column: DataColumn): boolean {
  const { names, index } = categories(column);
  const filled = index.filter((i) => i !== null).length;
  return names.length >= 2 && names.length <= GRID_MAX && filled > names.length;
}

export type GridCell = {
  row: number;
  column: number;
  value: number | null;
  // The table rows averaged into it.
  rows: number[];
};

export type GridData = { rowNames: string[]; columnNames: string[]; cells: GridCell[]; skipped: number };

type GridColumns = { rows: ColumnId; columns: ColumnId; measure: ColumnId };

// Every pair's mean, row by row; a pair no row has is a square with no value.
export function gridCells(spec: GridColumns, table: DataTable): GridData | null {
  const down = findColumn(table, spec.rows);
  const across = findColumn(table, spec.columns);
  const measure = findColumn(table, spec.measure);
  if (down === undefined || across === undefined || measure?.kind !== "number") return null;
  const r = categories(down);
  const c = categories(across);
  const sums = new Map<number, { sum: number; rows: number[] }>();
  let skipped = 0;
  for (let i = 0; i < table.rows; i++) {
    const ri = r.index[i];
    const ci = c.index[i];
    const v = measure.values[i];
    if (ri === null || ri === undefined || ci === null || ci === undefined || v === null || v === undefined) {
      if (v !== null && v !== undefined) skipped++;
      continue;
    }
    const key = ri * c.names.length + ci;
    const cell = sums.get(key) ?? { sum: 0, rows: [] };
    cell.sum += v;
    cell.rows.push(i);
    sums.set(key, cell);
  }
  const cells: GridCell[] = [];
  for (let ri = 0; ri < r.names.length; ri++) {
    for (let ci = 0; ci < c.names.length; ci++) {
      const s = sums.get(ri * c.names.length + ci);
      cells.push({ row: ri, column: ci, value: s === undefined ? null : s.sum / s.rows.length, rows: s?.rows ?? [] });
    }
  }
  return { rowNames: r.names, columnNames: c.names, cells, skipped };
}

// The first heatmap of a sheet: two columns that sort its rows, words first, and the reading
// it measures. Null when the sheet has no two such columns.
export function startingGridColumns(table: DataTable): GridColumns | null {
  // A repeat's number sorts the rows too, but a heatmap of "Rep 1, 2, 3" says nothing.
  const kinds = table.columns.filter((c) => isCategoryColumn(c) && !REPEAT_INDEX.test(c.name.trim()) && !isBookkeepingColumn(c));
  const rank = (c: DataColumn) => (c.kind === "text" ? 0 : c.kind === "date" ? 1 : 2);
  const sorted = [...kinds].sort((a, b) => rank(a) - rank(b));
  const [down, across] = sorted;
  if (down === undefined || across === undefined) return null;
  const used = new Set([down.id, across.id]);
  const readings = numberColumns(table).filter((c) => !used.has(c.id) && !isSpreadColumn(c) && !isBookkeepingColumn(c));
  const measure = readings.find((c) => !isCategoryColumn(c)) ?? readings[0];
  if (measure === undefined) return null;
  // The side with more kinds runs down, so a long list reads as rows.
  const [rows, columns] = categories(down).names.length >= categories(across).names.length ? [down, across] : [across, down];
  return { rows: rows.id, columns: columns.id, measure: measure.id };
}
