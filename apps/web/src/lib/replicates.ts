import { z } from "zod";
import { formatValue } from "./numbers";
import { axisColumns, findColumn, isBookkeepingColumn, isMeanColumn, isSpreadColumn, numberColumns, type DataColumn, type DataTable, type NumberColumn } from "./data-tables";
import { ColumnId, LayoutId } from "./ids";
import { roleOfName, SampleLayout, type Role } from "./layouts";
import { plateCells, plateLayout, PlateSource } from "./plates";
import { mean, summarize, type Summary } from "./stats";

// Repeats and their groups (decisions.md, "charts round 1"). A chart that summarizes repeats
// reads them from one of four shapes of sheet, and every number it shows (a mean, its SD, SEM
// or 95% CI, a test, a fit) is computed here from the repeats themselves, never read from a
// column of means.

export const SourceSeries = z.object({ name: z.string().trim().min(1).max(80), values: z.array(ColumnId).min(1).max(24) });

export const Source = z.discriminatedUnion("kind", [
  // Each column one group, its cells the repeats: "Control siRNA | SOX2 siRNA".
  z.object({ kind: z.literal("columns"), columns: z.array(ColumnId).min(1).max(24) }),
  // Each row one group, named or placed by its key, its value columns the repeats: "Rep 1, Rep 2,
  // Rep 3", or one column when there are none. Several series side by side (wild type, mutant).
  z.object({ kind: z.literal("rows"), key: ColumnId, series: z.array(SourceSeries).min(1).max(6) }),
  // A group column beside a value column; rows that share a group are its repeats.
  z.object({ kind: z.literal("long"), key: ColumnId, value: ColumnId }),
  // A plate's wells, grouped by its layout. The chart keeps its own copy of the layout, so a
  // saved layout changed later never changes a saved chart; layoutId says which it came from.
  z.object({ kind: z.literal("plate"), plate: PlateSource, layout: SampleLayout, layoutId: LayoutId.nullable() }),
]);
export type Source = z.infer<typeof Source>;

export type Repeat = { value: number; where: string };

export type Group = {
  id: string;
  label: string;
  series: string;
  role: Role;
  // Where it sits along a number axis: a standard's concentration, a dose, a time.
  at: number | null;
  dilution: number | null;
  repeats: Repeat[];
  // Wells or cells it names that hold no number.
  missing: number;
};

export type Grouped = {
  groups: Group[];
  // What the repeats measure, and the unit along a number axis.
  measure: { name: string; unit: string };
  key: { name: string; unit: string; numeric: boolean };
};

const where = (column: DataColumn, row: number) => `${column.name} row ${row + 1}`;

function keyText(column: DataColumn, row: number): { label: string; at: number | null } | null {
  const v = column.values[row];
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return { label: v, at: null };
  return { label: formatValue(v), at: v };
}

// The groups a source names in a table, in the order the sheet gives them.
export function groupsOf(table: DataTable, source: Source): Grouped {
  switch (source.kind) {
    case "columns": {
      const columns = source.columns.map((id) => findColumn(table, id)).filter((c): c is NumberColumn => c?.kind === "number");
      const units = new Set(columns.map((c) => c.unit ?? ""));
      return {
        groups: columns.map((c) => {
          const repeats: Repeat[] = [];
          let missing = 0;
          c.values.forEach((v, r) => (v === null ? missing++ : repeats.push({ value: v, where: where(c, r) })));
          // Trailing blanks are the end of a shorter column, not missing values.
          const last = c.values.findLastIndex((v) => v !== null);
          missing -= c.values.length - 1 - last;
          return { id: c.id, label: c.name, series: "", role: roleOfName(c.name), at: null, dilution: null, repeats, missing: Math.max(0, missing) };
        }),
        measure: { name: "", unit: units.size === 1 ? [...units][0] : "" },
        key: { name: "", unit: "", numeric: false },
      };
    }
    case "rows": {
      const key = findColumn(table, source.key);
      const groups: Group[] = [];
      const units = new Set<string>();
      for (const s of source.series) {
        const values = s.values.map((id) => findColumn(table, id)).filter((c): c is NumberColumn => c?.kind === "number");
        for (const c of values) units.add(c.unit ?? "");
        for (let r = 0; r < table.rows; r++) {
          const k = key === undefined ? null : keyText(key, r);
          if (k === null) continue;
          const repeats: Repeat[] = [];
          let missing = 0;
          for (const c of values) {
            const v = c.values[r];
            if (v === null || v === undefined) missing++;
            else repeats.push({ value: v, where: where(c, r) });
          }
          if (repeats.length === 0) continue;
          const role = k.at === null ? roleOfName(k.label) : "sample";
          groups.push({ id: `${s.name}|${r}`, label: k.label, series: source.series.length > 1 ? s.name : "", role, at: k.at, dilution: null, repeats, missing });
        }
      }
      const one = source.series.length === 1 && source.series[0].values.length === 1 ? findColumn(table, source.series[0].values[0]) : undefined;
      return {
        groups,
        measure: { name: one?.name ?? (source.series.length === 1 ? source.series[0].name : ""), unit: units.size === 1 ? [...units][0] : "" },
        key: { name: key?.name ?? "", unit: key?.kind === "number" ? (key.unit ?? "") : "", numeric: key?.kind === "number" || key?.kind === "date" },
      };
    }
    case "long": {
      const key = findColumn(table, source.key);
      const value = findColumn(table, source.value);
      const groups = new Map<string, Group>();
      if (key !== undefined && value?.kind === "number") {
        for (let r = 0; r < table.rows; r++) {
          const k = keyText(key, r);
          if (k === null) continue;
          const id = k.at === null ? k.label : String(k.at);
          let g = groups.get(id);
          if (g === undefined) {
            g = { id, label: k.label, series: "", role: k.at === null ? roleOfName(k.label) : "sample", at: k.at, dilution: null, repeats: [], missing: 0 };
            groups.set(id, g);
          }
          const v = value.values[r];
          if (v === null || v === undefined) g.missing++;
          else g.repeats.push({ value: v, where: where(value, r) });
        }
      }
      return {
        groups: [...groups.values()],
        measure: { name: value?.name ?? "", unit: value?.kind === "number" ? (value.unit ?? "") : "" },
        key: { name: key?.name ?? "", unit: key?.kind === "number" ? (key.unit ?? "") : "", numeric: key?.kind === "number" },
      };
    }
    case "plate": {
      const layout = plateLayout(table);
      const cells = layout === null ? [] : plateCells(table, layout, source.plate);
      const byWell = new Map(cells.map((c) => [c.name, c.value]));
      const unit = source.layout.unit;
      const value = source.plate.kind === "wells" ? findColumn(table, source.plate.value) : undefined;
      const valueUnit = value?.kind === "number" ? (value.unit ?? "") : layout?.kind === "grid" ? (layout.columns[0]?.column.unit ?? "") : "";
      const named = [...new Set(source.layout.groups.map((g) => g.name))];
      const ROLE_ORDER = { blank: 0, control: 1, standard: 2, sample: 3 } satisfies Record<Role, number>;
      // Blanks, controls, standards by amount, then each sample in the order it's first met
      // on the plate, by dose from low to high.
      const ordered = [...source.layout.groups].sort(
        (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || named.indexOf(a.name) - named.indexOf(b.name) || (a.conc ?? 0) - (b.conc ?? 0),
      );
      const groups = ordered.map((g, i): Group => {
        const repeats: Repeat[] = [];
        let missing = 0;
        for (const w of g.wells) {
          const v = byWell.get(w);
          if (v === null || v === undefined) missing++;
          else repeats.push({ value: v, where: w });
        }
        return { id: String(i), label: layoutLabel(g, unit), series: g.role === "sample" ? g.name : "", role: g.role, at: g.conc, dilution: g.dilution, repeats, missing };
      });
      return {
        groups,
        measure: { name: value?.name ?? plateReading(table), unit: valueUnit },
        key: { name: "Concentration", unit, numeric: true },
      };
    }
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

// What a grid of readings measured, from the instrument's notes: "Wavelengths: 570" is A570.
export function plateReading(table: DataTable): string {
  for (const note of table.notes) {
    const nm = /wavelengths?:?\s*(\d{3})\b/i.exec(note);
    if (nm !== null) return `A${nm[1]}`;
  }
  return "Reading";
}

function layoutLabel(g: SampleLayout["groups"][number], unit: string): string {
  const conc = g.conc === null ? "" : `${formatValue(g.conc)}${unit ? ` ${unit}` : ""}`;
  switch (g.role) {
    case "blank":
      return g.name || "Blank";
    case "control":
      return g.name || "Control";
    case "standard":
      return conc || g.name || "Standard";
    case "sample":
      return [g.name, conc].filter(Boolean).join(" ") || "Sample";
    default: {
      const _exhaustive: never = g.role;
      return _exhaustive;
    }
  }
}

export type Blank = { mean: number; n: number; wells: string[] };

// The blank: the mean of every blank well or row, or null when there are none.
export function blankOf(groups: readonly Group[]): Blank | null {
  const repeats = groups.filter((g) => g.role === "blank").flatMap((g) => g.repeats);
  return repeats.length === 0 ? null : { mean: mean(repeats.map((r) => r.value)), n: repeats.length, wells: repeats.map((r) => r.where) };
}

// The groups with the blank taken off every repeat, and the blanks themselves left out.
export function subtractBlank(groups: readonly Group[], blank: Blank): Group[] {
  return groups.filter((g) => g.role !== "blank").map((g) => ({ ...g, repeats: g.repeats.map((r) => ({ ...r, value: r.value - blank.mean })) }));
}

export type Summarized = Group & { summary: Summary };

export function summarized(groups: readonly Group[]): Summarized[] {
  return groups.map((g) => ({ ...g, summary: summarize(g.repeats.map((r) => r.value)) }));
}

// ---------------------------------------------------------------------------------------------
// Finding repeats in a sheet without a layout.

const REPEAT = /(^|[^\p{L}])(rep|replicate|repeat|trial|run|well|n)\.?\s*(\d+)\s*$/iu;
const INDEX = /^(#|no\.?|id|index|row|order|rep|replicate|repeat|well|trial|n|sample no\.?)$/i;

// Columns that repeat one measurement: "Rep 1, Rep 2, Rep 3", or "Wild type Rep 1…3" and
// "ΔsigB Rep 1…3" as two series. Each with at least two columns.
export function repeatSeries(table: DataTable): { name: string; values: ColumnId[] }[] {
  const byStem = new Map<string, ColumnId[]>();
  for (const c of numberColumns(table)) {
    const m = REPEAT.exec(c.name);
    if (m === null) continue;
    const stem = c.name.slice(0, m.index + m[1].length).trim();
    byStem.set(stem, [...(byStem.get(stem) ?? []), c.id]);
  }
  return [...byStem.entries()].filter(([, ids]) => ids.length >= 2).map(([stem, values]) => ({ name: stem || "Repeats", values }));
}

const isIndex = (c: DataColumn) => INDEX.test(c.name.trim()) || isBookkeepingColumn(c);

// A sheet's repeats as one of the shapes a summary chart reads, best first; empty when it has
// none. Means and spreads already in the sheet are passed over: the chart works them out.
export function sourcesFor(table: DataTable): Source[] {
  const out: Source[] = [];
  const reps = repeatSeries(table);
  const used = new Set(reps.flatMap((s) => s.values));
  if (reps.length > 0) {
    const key = table.columns.find((c) => !used.has(c.id) && c.kind !== "date" && !isSpreadColumn(c) && !isMeanColumn(c) && !(c.kind === "number" && isIndex(c)));
    const keyId = key?.id ?? axisColumns(table).find((c) => !used.has(c.id))?.id;
    if (keyId !== undefined) out.push({ kind: "rows", key: keyId, series: reps });
  }
  const text = table.columns.filter((c) => c.kind === "text");
  for (const key of text) {
    const values = key.values.filter((v): v is string => v !== null);
    const distinct = new Set(values);
    if (distinct.size < 2 || distinct.size * 2 > values.length || distinct.size > 60) continue;
    const value = numberColumns(table).find((c) => !isIndex(c) && !isSpreadColumn(c) && !isMeanColumn(c));
    if (value !== undefined) out.push({ kind: "long", key: key.id, value: value.id });
    break;
  }
  const measures = numberColumns(table).filter((c) => !isIndex(c) && !isSpreadColumn(c) && !isMeanColumn(c) && !used.has(c.id));
  if (text.length === 0 && reps.length === 0 && measures.length >= 1 && table.rows <= 1000) {
    const first = measures[0];
    const isAxis = measures.length >= 2 && rises(first);
    if (!isAxis) out.push({ kind: "columns", columns: measures.slice(0, 24).map((c) => c.id) });
  }
  return out;
}

function rises(column: NumberColumn): boolean {
  let last = -Infinity;
  for (const v of column.values) {
    if (v === null) continue;
    if (v <= last) return false;
    last = v;
  }
  return true;
}
