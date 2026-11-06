import { z } from "zod";
import { columnLabel, type DataTable, type DataTables, type NumberColumn, type TextColumn } from "./data-tables";
import { LayoutId, ProtocolId, Sha256 } from "./ids";
import { labelGrid, parseWell, PLATE_SHAPE, plateLayout, PlateSize, wellName, type Well } from "./plates";

// A plate's sample layout (decisions.md, "charts round 1"): which wells are blanks, controls,
// standards (with their concentration) or samples (with a name, and a dose or a dilution), and
// so which wells repeat each other. Wells with the same role, name, concentration and dilution
// are repeats; a layout keeps them as one group. db/migrations/0023_layouts.sql checks the same
// shape in layout_ok, for saved layouts and for the copy a chart keeps.

export const ROLES = ["blank", "control", "standard", "sample"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const ROLE_NAMES = { blank: "Blank", control: "Control", standard: "Standard", sample: "Sample" } satisfies Record<Role, string>;
export const ROLE_HELP = {
  blank: "Only buffer or medium. Its reading can be taken off the others.",
  control: "Treated the same, without what you're testing.",
  standard: "A known amount, for a standard curve.",
  sample: "What you're measuring, with a name.",
} satisfies Record<Role, string>;

export const WellText = z.string().regex(/^[A-P]([1-9]|1\d|2[0-4])$/, "expected a well like A1");

export const LayoutGroup = z.object({
  role: Role,
  name: z.string().trim().max(60),
  // A standard's concentration, or a sample's dose, in the layout's unit.
  conc: z.number().finite().nonnegative().nullable(),
  // How many times a sample was diluted before it was read; the result is multiplied back.
  dilution: z.number().finite().positive().nullable(),
  wells: z.array(WellText).min(1).max(384),
});
export type LayoutGroup = z.infer<typeof LayoutGroup>;

export const SampleLayout = z
  .object({
    size: PlateSize,
    unit: z.string().trim().max(24),
    groups: z.array(LayoutGroup).max(384),
  })
  .superRefine((layout, ctx) => {
    const problem = layoutProblem(layout);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });
export type SampleLayout = z.infer<typeof SampleLayout>;

export function layoutProblem(layout: { size: PlateSize; groups: readonly LayoutGroup[] }): string | null {
  const seen = new Set<string>();
  const { rows, columns } = PLATE_SHAPE[layout.size];
  for (const g of layout.groups) {
    for (const w of g.wells) {
      const well = parseWell(w);
      if (well === null || well.row >= rows || well.column >= columns) return `${w} isn't on a ${layout.size}-well plate.`;
      if (seen.has(w)) return `${w} is in two groups.`;
      seen.add(w);
    }
  }
  return null;
}

export const emptyLayout = (size: PlateSize, unit = ""): SampleLayout => ({ size, unit, groups: [] });

export type Assignment = { role: Role; name: string; conc: number | null; dilution: number | null };

const sameGroup = (a: Assignment, b: Assignment) => a.role === b.role && a.name === b.name && a.conc === b.conc && a.dilution === b.dilution;

function wellOrder(a: string, b: string): number {
  const wa = parseWell(a);
  const wb = parseWell(b);
  if (wa === null || wb === null) return a.localeCompare(b);
  return wa.row - wb.row || wa.column - wb.column;
}

// Groups merged when they're the same, wells in reading order, groups by their first well.
export function normalized(layout: SampleLayout): SampleLayout {
  const groups: LayoutGroup[] = [];
  for (const g of layout.groups) {
    const into = groups.find((q) => sameGroup(q, g));
    if (into === undefined) groups.push({ ...g, wells: [...g.wells] });
    else into.wells.push(...g.wells);
  }
  for (const g of groups) g.wells = [...new Set(g.wells)].sort(wellOrder);
  return { ...layout, groups: groups.filter((g) => g.wells.length > 0).sort((a, b) => wellOrder(a.wells[0], b.wells[0])) };
}

export function clearWells(layout: SampleLayout, wells: readonly string[]): SampleLayout {
  const gone = new Set(wells);
  return normalized({ ...layout, groups: layout.groups.map((g) => ({ ...g, wells: g.wells.filter((w) => !gone.has(w)) })) });
}

// Marks wells as one group, taking them out of whatever they were.
export function assignWells(layout: SampleLayout, wells: readonly string[], what: Assignment): SampleLayout {
  if (wells.length === 0) return layout;
  const cleared = clearWells(layout, wells);
  return normalized({ ...cleared, groups: [...cleared.groups, { ...cleanAssignment(what), wells: [...wells] }] });
}

function cleanAssignment(what: Assignment): Assignment {
  return {
    role: what.role,
    name: what.name.trim().slice(0, 60),
    conc: what.conc !== null && Number.isFinite(what.conc) && what.conc >= 0 ? what.conc : null,
    dilution: what.role === "sample" && what.dilution !== null && what.dilution > 0 && Number.isFinite(what.dilution) ? what.dilution : null,
  };
}

export function groupAt(layout: SampleLayout, well: string): LayoutGroup | null {
  return layout.groups.find((g) => g.wells.includes(well)) ?? null;
}

// The wells in the rectangle two wells span, in reading order: a drag across the plate.
export function wellsBetween(a: Well, b: Well): string[] {
  const out: string[] = [];
  for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) {
    for (let column = Math.min(a.column, b.column); column <= Math.max(a.column, b.column); column++) out.push(wellName({ row, column }));
  }
  return out;
}

export type SeriesFill = { role: "standard" | "sample"; name: string; start: number; factor: number; direction: "across" | "down" };

// A dilution series over the chosen wells: the first column (across) or row (down) at the
// start concentration, each next one divided by the factor; the wells in one column (or row)
// are repeats of each other.
export function fillSeries(layout: SampleLayout, wells: readonly string[], fill: SeriesFill): SampleLayout {
  const parsed = wells.map(parseWell).filter((w): w is Well => w !== null);
  if (parsed.length === 0 || !(fill.start > 0) || !(fill.factor > 0)) return layout;
  const steps = [...new Set(parsed.map((w) => (fill.direction === "across" ? w.column : w.row)))].sort((a, b) => a - b);
  let next = clearWells(layout, wells);
  steps.forEach((step, i) => {
    const conc = Number((fill.start / fill.factor ** i).toPrecision(6));
    const these = parsed.filter((w) => (fill.direction === "across" ? w.column : w.row) === step).map(wellName);
    next = assignWells(next, these, { role: fill.role, name: fill.name, conc, dilution: null });
  });
  return next;
}

// ---------------------------------------------------------------------------------------------
// Reading labels: what an instrument or a person writes in a well.

const CODE_BLANK = /^(blk|blank|buffer|medium|media|empty|bkg|background)$/i;
const CODE_CONTROL = /^(ctl|ctrl|control|vehicle|veh|untreated|mock|neg|negative|nc|no drug)$/i;
const STANDARD = /^(std|standard|cal|calibrator)(?![a-z])/i;
const REPEAT_SUFFIX = /[\s_-]*\b(rep|replicate|repeat|r)\.?\s*\d+$/i;
const INDEX_SUFFIX = /[\s_-]*\d+$/;
const CONC = /(-?\d+(?:[.,]\d+)?(?:e-?\d+)?)\s*(µM|uM|nM|mM|pM|M|µg\/mL|ug\/mL|ug\/ml|µg\/ml|mg\/mL|mg\/ml|ng\/mL|ng\/ml|g\/L|U\/mL|%)$/;

export type ReadLabel = Assignment & { unit: string | null };

// A well's label in plain words: "BLK", "Blank 2", "CTL", "Vehicle", "STD3", "Std 250 µg/mL",
// "Drug A 10 µM", "Lysate rep 1". Null for an empty cell.
export function readLabel(text: string): ReadLabel | null {
  let t = text.trim().replace(REPEAT_SUFFIX, "").trim();
  if (t === "") return null;
  let conc: number | null = null;
  let unit: string | null = null;
  const m = CONC.exec(t);
  if (m !== null) {
    conc = Number(m[1].replace(",", "."));
    unit = m[2].replace(/^u/, "µ").replace(/ml$/, "mL");
    t = t.slice(0, m.index).trim();
  }
  const bare = t.replace(INDEX_SUFFIX, "").trim();
  if (CODE_BLANK.test(bare)) return { role: "blank", name: "", conc: null, dilution: null, unit };
  if (CODE_CONTROL.test(bare) || /^(ctl|ctrl)\d*$/i.test(t)) {
    return { role: "control", name: /^(ctl|ctrl|control)$/i.test(bare) ? "" : t, conc, dilution: null, unit };
  }
  if (STANDARD.test(t)) return { role: "standard", name: conc === null ? t : "", conc, dilution: null, unit };
  return { role: "sample", name: t.slice(0, 60), conc, dilution: null, unit };
}

// The role a group's own name suggests, for sheets without a layout: a column or a group
// called "Control siRNA", "Vehicle" or "Blank".
export function roleOfName(name: string): Role {
  if (/(^|[^\p{L}])(blank|blk|buffer only|medium only|no cells)($|[^\p{L}])/iu.test(name)) return "blank";
  if (/(^|[^\p{L}])(control|ctrl|ctl|vehicle|untreated|mock|scrambled|non-?targeting|dmso)($|[^\p{L}])/iu.test(name)) return "control";
  return "sample";
}

// Pasted cells from a spreadsheet, one per well from A1: a grid of labels, optionally with the
// plate's column numbers across the top and row letters down the side. A cell that's only a
// number sets that well's concentration (making it a sample if it wasn't anything yet).
export function pasteLayout(layout: SampleLayout, text: string): { layout: SampleLayout; wells: number; skipped: number } {
  const lines = text.replace(/\r/g, "").split("\n").filter((l, i, all) => l.trim() !== "" || i < all.length - 1);
  let rows = lines.map((l) => l.split(l.includes("\t") ? "\t" : ","));
  if (rows.length > 0 && rows[0].slice(1).every((c, i) => c.trim() === String(i + 1) || c.trim() === "")) rows = rows.slice(1);
  const lettered = rows.length > 0 && rows.every((r, i) => (r[0] ?? "").trim().toUpperCase() === "ABCDEFGHIJKLMNOP"[i]);
  if (lettered) rows = rows.map((r) => r.slice(1));
  const shape = PLATE_SHAPE[layout.size];
  let next = layout;
  let wells = 0;
  let skipped = 0;
  rows.forEach((cells, row) => {
    cells.forEach((cell, column) => {
      const t = cell.trim();
      if (t === "") return;
      if (row >= shape.rows || column >= shape.columns) {
        skipped++;
        return;
      }
      const well = wellName({ row, column });
      const number = Number(t.replace(",", "."));
      if (Number.isFinite(number) && /^[-\d.,eE]+$/.test(t)) {
        const own = groupAt(next, well);
        next = assignWells(next, [well], own === null ? { role: "sample", name: "", conc: number, dilution: null } : { ...own, conc: number });
        wells++;
        return;
      }
      const label = readLabel(t);
      if (label === null) return;
      next = assignWells(next, [well], label);
      if (label.unit !== null && next.unit === "") next = { ...next, unit: label.unit };
      wells++;
    });
  });
  return { layout: next, wells, skipped };
}

// ---------------------------------------------------------------------------------------------
// Reading a layout from the export itself.

const CONC_NAME = /\b(conc|concentration|dose|amount)\b/i;
const DILUTION_NAME = /\b(dil|dilution|dilution factor)\b/i;
const UNIT_IN = /\(([^()]{1,24})\)\s*$/;

export type FoundLayout = { layout: SampleLayout; from: string };

// The layout an export carries for this table's plate, or null. Two shapes are read: a plate
// listed by well with a column naming each well's sample ("Blank", "Std 2", "Lysate rep 1"),
// and a grid of results with a layout block of labels in the same file (Gen5 writes one when
// asked), with an optional grid of concentrations.
export function layoutFromFile(doc: DataTables, table: DataTable): FoundLayout | null {
  const plate = plateLayout(table);
  if (plate === null) return null;
  if (plate.kind === "wells") {
    if (plate.label === null) return null;
    return fromList(table, plate.well, plate.label, plate.size);
  }
  if (plate.kind !== "grid") return null;
  for (const other of doc.tables) {
    if (other === table) continue;
    const grid = labelGrid(other);
    if (grid === null || grid.size !== plate.size) continue;
    let layout = emptyLayout(plate.size);
    grid.rows.values.forEach((letter, r) => {
      const row = letter === null ? -1 : "ABCDEFGHIJKLMNOP".indexOf(letter.trim().toUpperCase());
      if (row < 0) return;
      for (const { column, index } of grid.columns) {
        const text = column.values[r];
        const label = text === null ? null : readLabel(text);
        if (label === null) continue;
        layout = assignWells(layout, [wellName({ row, column: index })], label);
        if (label.unit !== null && layout.unit === "") layout = { ...layout, unit: label.unit };
      }
    });
    if (layout.groups.length === 0) continue;
    const concs = concGrid(doc, plate.size, [table, other]);
    if (concs !== null) layout = withConcs(layout, concs.values, concs.unit);
    return { layout, from: concs === null ? `the layout in ${other.name}` : `the layout in ${other.name} and the concentrations in ${concs.table}` };
  }
  return null;
}

function fromList(table: DataTable, well: TextColumn, label: TextColumn, size: PlateSize): FoundLayout | null {
  const numbers = table.columns.filter((c): c is NumberColumn => c.kind === "number");
  const conc = numbers.find((c) => CONC_NAME.test(c.name)) ?? null;
  const dilution = numbers.find((c) => DILUTION_NAME.test(c.name)) ?? null;
  let layout = emptyLayout(size, conc?.unit ?? "");
  well.values.forEach((text, r) => {
    const w = text === null ? null : parseWell(text);
    const name = label.values[r];
    const read = name === null ? null : readLabel(name);
    if (w === null || read === null) return;
    const c = conc?.values[r] ?? null;
    const d = dilution?.values[r] ?? null;
    layout = assignWells(layout, [wellName(w)], { ...read, conc: c ?? read.conc, dilution: read.role === "sample" && d !== null && d > 0 ? d : null });
    if (layout.unit === "" && read.unit !== null) layout = { ...layout, unit: read.unit };
  });
  if (layout.groups.length === 0 || layout.groups.every((g) => g.role === "sample" && g.wells.length === 1 && g.conc === null)) return null;
  const used = [label, conc, dilution].filter((c) => c !== null).map((c) => columnLabel(c));
  return { layout, from: `the ${used.join(", ")} ${used.length === 1 ? "column" : "columns"}` };
}

function concGrid(doc: DataTables, size: PlateSize, skip: readonly DataTable[]): { values: Map<string, number>; unit: string; table: string } | null {
  for (const t of doc.tables) {
    if (skip.includes(t)) continue;
    const named = t.notes.some((n) => CONC_NAME.test(n)) || CONC_NAME.test(t.name);
    const plate = named ? plateLayout(t) : null;
    if (plate?.kind !== "grid" || plate.size !== size) continue;
    const values = new Map<string, number>();
    plate.rows.values.forEach((letter, r) => {
      const row = letter === null ? -1 : "ABCDEFGHIJKLMNOP".indexOf(letter.trim().toUpperCase());
      if (row < 0) return;
      for (const { column, index } of plate.columns) {
        const v = column.values[r];
        if (v !== null && v !== undefined) values.set(wellName({ row, column: index }), v);
      }
    });
    const note = t.notes.find((n) => CONC_NAME.test(n)) ?? "";
    return { values, unit: UNIT_IN.exec(note)?.[1]?.trim() ?? "", table: t.name };
  }
  return null;
}

function withConcs(layout: SampleLayout, concs: ReadonlyMap<string, number>, unit: string): SampleLayout {
  let next: SampleLayout = { ...layout, unit: layout.unit || unit, groups: [] };
  for (const g of layout.groups) {
    for (const w of g.wells) {
      const c = concs.get(w);
      next = assignWells(next, [w], { ...g, conc: c ?? g.conc });
    }
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// Saying what a layout holds.

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "3 blanks, 3 controls and Drug A at 5 concentrations (3 wells each)".
export function describeLayout(layout: SampleLayout): string {
  const parts: string[] = [];
  const wellsOf = (role: Role) => layout.groups.filter((g) => g.role === role).reduce((n, g) => n + g.wells.length, 0);
  const blanks = wellsOf("blank");
  const controls = wellsOf("control");
  if (blanks > 0) parts.push(count(blanks, "blank"));
  if (controls > 0) parts.push(count(controls, "control"));
  const standards = layout.groups.filter((g) => g.role === "standard");
  if (standards.length > 0) parts.push(`${count(standards.length, "standard")}${eachPhrase(standards)}`);
  const names = [...new Set(layout.groups.filter((g) => g.role === "sample").map((g) => g.name || "Unnamed"))];
  for (const name of names.slice(0, 4)) {
    const groups = layout.groups.filter((g) => g.role === "sample" && (g.name || "Unnamed") === name);
    const doses = groups.filter((g) => g.conc !== null).length;
    parts.push(doses >= 2 ? `${name} at ${doses} concentrations${eachPhrase(groups)}` : `${name}${eachPhrase(groups)}`);
  }
  if (names.length > 4) parts.push(`${names.length - 4} more samples`);
  if (parts.length === 0) return "No wells marked yet.";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function eachPhrase(groups: readonly LayoutGroup[]): string {
  const sizes = [...new Set(groups.map((g) => g.wells.length))];
  if (sizes.length !== 1) return "";
  if (groups.length === 1) return sizes[0] === 1 ? " (1 well)" : ` (${sizes[0]} wells)`;
  return sizes[0] === 1 ? " (1 well each)" : ` (${sizes[0]} wells each)`;
}

// ---------------------------------------------------------------------------------------------
// A layout saved to use again (sample_layouts).

export const LAYOUT_COLUMNS = "id, name, protocol_id, sha256, layout, created_by, created_at, updated_at";

export type SavedLayout = { id: LayoutId; name: string; protocolId: ProtocolId | null; sha256: Sha256 | null; layout: SampleLayout; updatedAt: string };

export const LayoutRow = z
  .object({
    id: LayoutId,
    name: z.string(),
    protocol_id: ProtocolId.nullable(),
    sha256: Sha256.nullable(),
    layout: SampleLayout,
    updated_at: z.string(),
  })
  .transform((r): SavedLayout => ({ id: r.id, name: r.name, protocolId: r.protocol_id, sha256: r.sha256, layout: r.layout, updatedAt: r.updated_at }));
export const LayoutRows = z.array(LayoutRow);

export const LayoutWire = z.object({
  id: LayoutId,
  name: z.string(),
  protocolId: ProtocolId.nullable(),
  sha256: Sha256.nullable(),
  layout: SampleLayout,
  updatedAt: z.string(),
}) satisfies z.ZodType<SavedLayout>;
export const LayoutsWire = z.array(LayoutWire);

export const SaveLayoutRequest = z.object({
  name: z.string().trim().min(1, "Name the layout.").max(120),
  protocolId: ProtocolId.nullable(),
  sha256: Sha256.nullable(),
  layout: SampleLayout,
});
export type SaveLayoutRequest = z.input<typeof SaveLayoutRequest>;

// The layouts to offer for a plate: this size only, the chart's protocol's first, newest first.
export function layoutChoices(saved: readonly SavedLayout[], size: PlateSize, protocolId: ProtocolId | null): SavedLayout[] {
  return saved
    .filter((s) => s.layout.size === size)
    .sort((a, b) => Number(b.protocolId !== null && b.protocolId === protocolId) - Number(a.protocolId !== null && a.protocolId === protocolId) || b.updatedAt.localeCompare(a.updatedAt));
}
