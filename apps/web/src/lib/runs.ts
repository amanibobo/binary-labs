import { z } from "zod";
import { MAX_SERIES, nextStyle, type Series, type XYSpec } from "./charts";
import { mainTable, type DataColumn, type DataTable, type DataTables } from "./data-tables";
import { LabelOutcome } from "./domain";
import { ColumnId, LocationId, Sha256 } from "./ids";

// Charts across several files (decisions.md, "charts round 2"): a line or scatter chart names
// other files of the same kind (`spec.runs`), and each is drawn with the same columns, found by
// header and unit as checks find them. A run labeled failed is drawn gray and dashed, never
// hidden. Pure, so the builder, the figure and the export draw the same chart.

// A file as a run: what the legend calls it, when it ran, and how it went.
export const RunInfo = z.object({
  sha256: Sha256,
  locationId: LocationId.nullable(),
  name: z.string(),
  date: z.string().nullable(),
  outcome: LabelOutcome.nullable(),
  experiment: z.string().nullable(),
});
export type RunInfo = z.infer<typeof RunInfo>;
export const RunInfos = z.array(RunInfo);

// What "Add runs" offers: the file's experiment's other data sheets first, then the lab's latest.
export const RunChoicesWire = z.object({ experiment: z.string().nullable(), runs: RunInfos });
export type RunChoices = z.infer<typeof RunChoicesWire>;

export const RunsQuery = z.object({ sha256: z.array(Sha256).min(1).max(12) });

export function isFailed(run: RunInfo | undefined): boolean {
  return run?.outcome === "failed";
}

// A run's short name, for a legend: its label's title, or its file name without the extension.
export function runName(run: RunInfo): string {
  return run.name.replace(/\.(csv|tsv|txt|xlsx?|xlsm)$/i, "");
}

export type RunState = { run: RunInfo; drawn: boolean; why: string | null };

export type Combined = {
  spec: XYSpec;
  table: DataTable;
  // Series of failed runs, drawn gray and dashed.
  muted: ReadonlySet<string>;
  runs: RunState[];
  notes: string[];
};

const key = (c: DataColumn) => `${c.name.trim().toLowerCase()}\u0000${(c.unit ?? "").trim().toLowerCase()}`;

function letters(i: number): ColumnId {
  let n = i;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return ColumnId.parse(out);
}

// The table in another run that holds the same columns: the sheet named as the chart's, else the
// first that has them all, else the file's main table.
function matchTable(doc: DataTables, sheet: string, wanted: readonly DataColumn[]): DataTable | null {
  const has = (t: DataTable) => wanted.every((w) => t.columns.some((c) => key(c) === key(w) && c.kind === w.kind));
  const named = doc.tables.find((t) => t.name === sheet);
  if (named !== undefined && has(named)) return named;
  return doc.tables.find(has) ?? null;
}

export type RunTables = { run: RunInfo; doc: DataTables | null };

// The chart with every run's columns side by side in one table, each run's series reading along
// its own x, so the x/y figure, the numbers and the export draw it unchanged.
export function combineRuns(spec: XYSpec, base: { run: RunInfo; table: DataTable }, others: readonly RunTables[]): Combined {
  const find = (t: DataTable, id: ColumnId | null) => (id === null ? undefined : t.columns.find((c) => c.id === id));
  const x = find(base.table, spec.x.column);
  const wanted = (s: Series) => [s.x === null ? x : find(base.table, s.x), find(base.table, s.column), find(base.table, s.error)];
  const needed = [x, ...spec.series.flatMap(wanted)].filter((c): c is DataColumn => c !== undefined);
  const columns: DataColumn[] = [];
  const series: Series[] = [];
  const muted = new Set<string>();
  const runs: RunState[] = [];
  const notes: string[] = [];
  const limit = MAX_SERIES[spec.type];
  const many = spec.series.length > 1;
  let rows = 0;
  let sharedX: ColumnId | null = null;

  const add = (column: DataColumn, run: RunInfo): ColumnId => {
    const id = letters(columns.length);
    columns.push({ ...column, id, name: `${runName(run)}: ${column.name}` });
    return id;
  };

  const all: { run: RunInfo; table: DataTable | null; why: string | null }[] = [
    { run: base.run, table: base.table, why: null },
    ...others.map(({ run, doc }) => {
      if (doc === null) return { run, table: null, why: "Its table isn't ready yet." };
      const table = matchTable(doc, base.table.name, needed) ?? null;
      const main = mainTable(doc);
      const lacking = table === null && main !== null ? needed.filter((w) => !main.columns.some((c) => key(c) === key(w))).map((c) => c.name) : [];
      return { run, table, why: table === null ? `It has no ${lacking.length > 0 ? lacking.join(" or ") : "matching"} column.` : null };
    }),
  ];

  for (const { run, table, why } of all) {
    if (table === null) {
      runs.push({ run, drawn: false, why });
      continue;
    }
    const match = (c: DataColumn | undefined) => (c === undefined ? undefined : table === base.table ? c : table.columns.find((t) => key(t) === key(c) && t.kind === c.kind));
    const runX = match(x);
    if (runX === undefined) {
      runs.push({ run, drawn: false, why: `It has no ${x?.name ?? "x"} column.` });
      continue;
    }
    const xId = add(runX, run);
    sharedX ??= xId;
    let drew = false;
    for (const s of spec.series) {
      if (series.length >= limit) break;
      const value = match(find(base.table, s.column));
      if (value === undefined) continue;
      const own = s.x === null ? undefined : match(find(base.table, s.x));
      const error = match(find(base.table, s.error));
      const name = many ? `${s.name}, ${runName(run)}` : runName(run);
      const next: Series = {
        column: add(value, run),
        name: isFailed(run) ? `${name} (failed)`.slice(0, 80) : name.slice(0, 80),
        ...nextStyle(series, spec.type),
        error: error === undefined ? null : add(error, run),
        x: own !== undefined ? add(own, run) : xId === sharedX ? null : xId,
      };
      if (isFailed(run)) muted.add(next.column);
      series.push(next);
      drew = true;
    }
    rows = Math.max(rows, table.rows);
    runs.push({ run, drawn: drew, why: drew ? null : series.length >= limit ? `The chart already has ${limit} lines.` : "It has none of the chart's columns." });
  }
  const left = runs.filter((r) => !r.drawn);
  for (const r of left) notes.push(`${runName(r.run)} isn't drawn. ${r.why ?? ""}`.trim());

  const padded = columns.map((c): DataColumn => {
    const pad = <T,>(values: readonly T[]) => [...values, ...Array.from({ length: rows - values.length }, () => null)];
    switch (c.kind) {
      case "number":
        return { ...c, values: pad(c.values) };
      case "date":
        return { ...c, values: pad(c.values) };
      case "text":
        return { ...c, values: pad(c.values) };
      default: {
        const _exhaustive: never = c;
        return _exhaustive;
      }
    }
  });
  const table: DataTable = { ...base.table, rows, columns: padded };
  return { spec: { ...spec, x: { ...spec.x, column: sharedX ?? spec.x.column }, series }, table, muted, runs, notes };
}
