import { plateShape, type HeatmapSpec } from "./charts";
import { formatValue, linearTicks, niceDomain, textWidth, TICK_FONT, TITLE_FONT, type Tick } from "./chart-geometry";
import { findColumn, type DataTable } from "./data-tables";
import { plateCells, plateLayout, rowLetter, wellName, type PlateCell } from "./plates";

// Where every well of a plate heatmap goes and how far along the color scale it sits. Pure, as
// chart-geometry.ts is; plate-svg.tsx draws it.

// The sequential ramp: one hue, the dataviz reference blue, light to dark on the light surface
// and dark to light on the dark one, so a low value recedes into the page in both. Each set of
// five steps passes the dataviz validator's ramp checks on our surfaces (decisions.md, "plate
// heatmaps"); globals.css carries them as --chart-seq-<n>, and a test checks they agree.
export const SEQUENTIAL = {
  light: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"],
  dark: ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#b7d3f6"],
} as const;
export const RAMP_STEPS = SEQUENTIAL.light.length;

export type PlateWell = PlateCell & {
  cx: number;
  cy: number;
  // 0 at the scale's low end, 1 at its high end; null for a well with no number.
  t: number | null;
  // The plate has this well, but the table gives it no value.
  missing: boolean;
};

export type PlatePlot = {
  width: number;
  height: number;
  title: { text: string; x: number; y: number } | null;
  radius: number;
  pitch: number;
  plate: { left: number; top: number; width: number; height: number };
  wells: PlateWell[];
  rowLabels: { text: string; x: number; y: number }[];
  columnLabels: { text: string; x: number; y: number }[];
  scale: { left: number; top: number; width: number; height: number; ticks: Tick[]; title: string; lo: number; hi: number } | null;
  rows: number;
  columns: number;
  notes: string[];
};

const PITCH_MAX = 52;
const BAR_HEIGHT = 10;

function valueTitle(spec: HeatmapSpec): string {
  const t = spec.value.title.trim();
  const u = spec.value.unit.trim();
  if (t === "") return u;
  return u === "" ? t : `${t} (${u})`;
}

// Which read of a kinetic plate is shown, in words: "Read 31 of 31, at 30 min".
export function readLabel(spec: HeatmapSpec, table: DataTable): string | null {
  const source = spec.plate.source;
  if (source.kind !== "read") return null;
  const layout = plateLayout(table);
  const time = layout?.kind === "read" ? layout.time : null;
  const at = time?.values[source.row];
  const when =
    time === null || at === null || at === undefined
      ? ""
      : time.kind === "date"
        ? `, at ${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(at)}`
        : `, at ${formatValue(at)}${time.unit ? ` ${time.unit}` : ""}`;
  return `Read ${source.row + 1} of ${table.rows}${when}`;
}

export function plotPlate(spec: HeatmapSpec, table: DataTable, size: { width: number; height: number }, options: { title?: string } = {}): PlatePlot {
  const notes: string[] = [];
  const { rows, columns } = plateShape(spec);
  const layout = plateLayout(table);
  const cells = layout === null ? [] : plateCells(table, layout, spec.plate.source);
  const byName = new Map(cells.map((c) => [c.name, c]));

  let lo = Infinity;
  let hi = -Infinity;
  for (const c of cells) {
    if (c.value === null) continue;
    lo = Math.min(lo, c.value);
    hi = Math.max(hi, c.value);
  }
  const hasData = Number.isFinite(lo);
  if (!hasData) notes.push("No well has a number to show.");
  const [niceLo, niceHi] = hasData ? niceDomain(lo, hi, 4) : [0, 1];
  let domain: [number, number] = [spec.value.min ?? (hasData ? lo : niceLo), spec.value.max ?? (hasData ? hi : niceHi)];
  if (domain[0] >= domain[1]) domain = hasData && lo < hi ? [lo, hi] : [niceLo, niceHi];

  const title = options.title ? { text: options.title, x: 0, y: TITLE_FONT + 4 } : null;
  let top = 8 + (title ? TITLE_FONT + 16 : 0);
  const scaleTitle = valueTitle(spec);
  // Below the plate: the scale's bar, its tick labels and its title.
  const below = 20 + BAR_HEIGHT + 6 + TICK_FONT + (scaleTitle ? TICK_FONT + 10 : 0);
  const labelLeft = textWidth("P", TICK_FONT) + 12;
  top += TICK_FONT + 10;
  const pitch = Math.max(8, Math.min(PITCH_MAX, (size.width - labelLeft - 4) / columns, (size.height - top - below) / rows));
  const plateWidth = pitch * columns;
  const plateHeight = pitch * rows;
  const left = labelLeft;
  const radius = Math.max(3, pitch / 2 - Math.max(1.5, pitch * 0.08));

  const wells: PlateWell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const name = wellName({ row: r, column: c });
      const cell = byName.get(name);
      const value = cell?.value ?? null;
      wells.push({
        row: r,
        column: c,
        name,
        value,
        label: cell?.label ?? null,
        cx: left + pitch * (c + 0.5),
        cy: top + pitch * (r + 0.5),
        t: value === null ? null : Math.min(1, Math.max(0, (value - domain[0]) / (domain[1] - domain[0]))),
        missing: cell === undefined,
      });
    }
  }
  const outside = cells.filter((c) => c.row >= rows || c.column >= columns).length;
  if (outside > 0) notes.push(`${outside} wells are outside a ${spec.plate.size}-well plate and aren't shown.`);
  const blank = wells.filter((w) => !w.missing && w.value === null).length;
  if (blank > 0) notes.push(`${blank} ${blank === 1 ? "well has" : "wells have"} no number.`);

  const every = pitch < 16 ? 2 : 1;
  const rowLabels = Array.from({ length: rows }, (_, r) => ({ text: rowLetter(r), x: left - 10, y: top + pitch * (r + 0.5) })).filter(
    (_, r) => r % every === 0,
  );
  const columnLabels = Array.from({ length: columns }, (_, c) => ({ text: String(c + 1), x: left + pitch * (c + 0.5), y: top - 8 })).filter(
    (_, c) => c % every === 0,
  );

  const barWidth = Math.min(plateWidth, 320);
  const barTop = top + plateHeight + 20;
  const map = (v: number) => left + ((v - domain[0]) / (domain[1] - domain[0])) * barWidth;
  const ticks = linearTicks(domain[0], domain[1], Math.max(2, Math.floor(barWidth / 70)))
    .filter((v) => v >= domain[0] && v <= domain[1])
    .map((v) => ({ pos: map(v), label: formatValue(v) }));
  const scale = hasData ? { left, top: barTop, width: barWidth, height: BAR_HEIGHT, ticks, title: scaleTitle, lo: domain[0], hi: domain[1] } : null;

  const usedHeight = barTop + below - 20;
  return {
    width: size.width,
    height: Math.min(size.height, Math.ceil(usedHeight)),
    title,
    radius,
    pitch,
    plate: { left, top, width: plateWidth, height: plateHeight },
    wells,
    rowLabels,
    columnLabels,
    scale,
    rows,
    columns,
    notes,
  };
}

// A plate fits its width: the height it needs at that width.
export function plateHeight(spec: HeatmapSpec, width: number): number {
  const { rows, columns } = plateShape(spec);
  const pitch = Math.min(PITCH_MAX, (width - 30) / columns);
  return Math.ceil(TICK_FONT + 18 + pitch * rows + 20 + BAR_HEIGHT + 6 + TICK_FONT + TICK_FONT + 10 + 8);
}

// The well's color as CSS: two neighboring ramp steps mixed in OKLab, so the theme's own steps
// (CSS variables) carry it in light and dark.
export function screenFill(t: number): string {
  const [i, f] = rampPosition(t);
  if (f === 0) return `var(--chart-seq-${i})`;
  return `color-mix(in oklab, var(--chart-seq-${i}) ${round1((1 - f) * 100)}%, var(--chart-seq-${i + 1}))`;
}

// The same color as hex, for an exported figure in the light theme.
export function exportFill(t: number): string {
  const [i, f] = rampPosition(t);
  if (f === 0) return SEQUENTIAL.light[i];
  return mixOklab(SEQUENTIAL.light[i], SEQUENTIAL.light[i + 1], f);
}

function rampPosition(t: number): [number, number] {
  const p = Math.min(1, Math.max(0, t)) * (RAMP_STEPS - 1);
  const i = Math.min(RAMP_STEPS - 2, Math.floor(p));
  const f = p - i;
  return f >= 1 ? [i + 1, 0] : [i, Math.round(f * 1000) / 1000];
}

const round1 = (v: number) => Math.round(v * 10) / 10;

// sRGB hex <-> OKLab (Björn Ottosson's matrices), to mix two steps as CSS color-mix does.
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function fromLinear(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}
function hexToOklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToHex([L, a, b]: [number, number, number]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, fromLinear(c))) * 255).toString(16).padStart(2, "0")).join("")}`;
}
export function mixOklab(from: string, to: string, f: number): string {
  const a = hexToOklab(from);
  const b = hexToOklab(to);
  return oklabToHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
}

// The value column a plate's readout and numbers name, for its unit.
export function plateValueName(spec: HeatmapSpec, table: DataTable): string {
  const source = spec.plate.source;
  if (source.kind === "wells") return findColumn(table, source.value)?.name ?? "Value";
  return spec.value.title.trim() || "Value";
}
