import { ChartRows, type SavedChart } from "@/lib/charts";
import { DataTables, type TableState } from "@/lib/data-tables";
import type { FileHit } from "@/lib/domain";
import { LocationId, Sha256 } from "@/lib/ids";
import { recentFiles, searchHits } from "./data";
import bioreactorJson from "./tables/Bioreactor_run12.json";
import bradfordJson from "./tables/Bradford_2026-10-30.json";
import elisaJson from "./tables/ELISA_plate3.json";
import plateJson from "./tables/plate7_A420.json";
import secJson from "./tables/SEC_trace_141026.json";
import bradfordPlateJson from "./tables/Bradford_plate_2026-11-05.json";
import cellsJson from "./tables/cell_sizes.json";
import growthJson from "./tables/growth_curve.json";
import knockdownJson from "./tables/knockdown_qpcr.json";
import pendulumJson from "./tables/pendulum.json";
import groupsJson from "./tables/treatments_4groups.json";
import viabilityLayoutJson from "./tables/viability_drugA_layout.json";
import viabilityJson from "./tables/viability_drugA.json";
import { emptyLayout, fillSeries, assignWells, LayoutRows, wellsBetween, type SavedLayout } from "@/lib/layouts";

// Dev-only chart data. The tables are the worker's own parse of the instrument exports in
// workers/tests/fixtures/tables (workers/scripts/make_table_fixtures.py writes both).

export const PLATE = Sha256.parse("1".repeat(64));
export const BRADFORD = Sha256.parse("4".repeat(64));
export const SEC = Sha256.parse("f".repeat(64));
export const BIOREACTOR = Sha256.parse("b".repeat(64));
export const ELISA = Sha256.parse("e".repeat(64));
// The round's exports (decisions.md, "charts round 1").
export const DOSE_LAYOUT = Sha256.parse("d1".repeat(32));
export const DOSE = Sha256.parse("d2".repeat(32));
export const BRADFORD_PLATE = Sha256.parse("d3".repeat(32));
export const KNOCKDOWN = Sha256.parse("d4".repeat(32));
export const GROUPS = Sha256.parse("d5".repeat(32));
export const GROWTH = Sha256.parse("d6".repeat(32));
export const CELLS = Sha256.parse("d7".repeat(32));
export const PENDULUM = Sha256.parse("d8".repeat(32));

const TABLES = new Map<Sha256, DataTables>([
  [PLATE, DataTables.parse(plateJson)],
  [BRADFORD, DataTables.parse(bradfordJson)],
  [SEC, DataTables.parse(secJson)],
  [BIOREACTOR, DataTables.parse(bioreactorJson)],
  [ELISA, DataTables.parse(elisaJson)],
  [DOSE_LAYOUT, DataTables.parse(viabilityLayoutJson)],
  [DOSE, DataTables.parse(viabilityJson)],
  [BRADFORD_PLATE, DataTables.parse(bradfordPlateJson)],
  [KNOCKDOWN, DataTables.parse(knockdownJson)],
  [GROUPS, DataTables.parse(groupsJson)],
  [GROWTH, DataTables.parse(growthJson)],
  [CELLS, DataTables.parse(cellsJson)],
  [PENDULUM, DataTables.parse(pendulumJson)],
]);

export function fixtureTable(sha: Sha256): TableState {
  const tables = TABLES.get(sha);
  return tables === undefined ? { state: "failed", error: "We couldn't read a table in this file. Not a spreadsheet." } : { state: "ready", tables };
}

export function fixtureHit(sha: Sha256): FileHit {
  const hit = [...recentFiles, ...searchHits].find((h) => h.sha256 === sha);
  if (hit === undefined) throw new Error(`no fixture file ${sha}`);
  return hit;
}

// Files only the chart fixtures use, which search and Browse don't list.
const CHART_ONLY: Record<string, string> = {
  [BIOREACTOR]: "Bioreactor_run12.csv",
  [ELISA]: "ELISA_plate3.csv",
  [DOSE_LAYOUT]: "viability_drugA_layout.csv",
  [DOSE]: "viability_drugA.csv",
  [BRADFORD_PLATE]: "Bradford_plate_2026-11-05.csv",
  [KNOCKDOWN]: "knockdown_qpcr.csv",
  [GROUPS]: "treatments_4groups.csv",
  [GROWTH]: "growth_curve.xlsx",
  [CELLS]: "cell_sizes.csv",
  [PENDULUM]: "pendulum.csv",
};

export function fixtureFile(sha: Sha256): { locationId: LocationId; sha256: Sha256; name: string } {
  const name = CHART_ONLY[sha];
  if (name !== undefined) return { locationId: LocationId.parse(`6c1c2c39-5a4e-4c55-9d7b-${sha.slice(0, 12)}`), sha256: sha, name };
  const location = fixtureHit(sha).locations[0];
  return { locationId: location.id, sha256: sha, name: location.originalName };
}

const priya = "00000000-0000-4000-8000-00000000000b";
const ade = "00000000-0000-4000-8000-00000000000a";
const purification = "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001";
const chartId = (n: number) => `8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c${String(n).padStart(4, "0")}`;
const axis = (title: string, unit: string) => ({ title, unit, min: null, max: null });
const COLORS = ["blue", "orange", "aqua", "violet", "magenta", "green"] as const;

export const savedCharts: SavedChart[] = ChartRows.parse([
  {
    id: chartId(1),
    sha256: BRADFORD,
    sheet: "Standards",
    title: "Bradford standard curve, Oct 30",
    spec: {
      version: 1,
      type: "scatter",
      x: { column: "A", ...axis("BSA", "µg/mL") },
      y: { ...axis("A595", "AU"), scale: "linear" },
      series: [{ column: "E", name: "Mean of 3", color: "blue", error: "F" }],
      legend: "top",
    },
    protocol_id: purification,
    created_by: priya,
    created_at: "2026-10-30T16:02:00Z",
    updated_at: "2026-10-30T16:05:00Z",
  },
  {
    id: chartId(2),
    sha256: SEC,
    sheet: "Table 1",
    title: "Batch 3 SEC, Superdex 200",
    spec: {
      version: 1,
      type: "line",
      x: { column: "A", ...axis("Elution volume", "ml") },
      y: { ...axis("Absorbance", "mAU"), scale: "linear" },
      series: [
        { column: "B", name: "A280", color: "blue", error: null },
        { column: "D", name: "A260", color: "orange", error: null, x: "C" },
      ],
      legend: "top",
    },
    protocol_id: purification,
    created_by: ade,
    created_at: "2026-10-14T14:00:00Z",
    updated_at: "2026-10-15T09:30:00Z",
  },
  {
    id: chartId(3),
    sha256: PLATE,
    sheet: "Table 1",
    title: "Plate 7 kinetics at 420 nm",
    spec: {
      version: 1,
      type: "line",
      x: { column: "A", ...axis("Time", "min") },
      y: { ...axis("A420", "AU"), scale: "linear" },
      series: [
        { column: "C", name: "Row A, 0 µM", color: "blue", error: null },
        { column: "AM", name: "Row D, 150 µM", color: "orange", error: null },
        { column: "CI", name: "Row H, 350 µM", color: "aqua", error: null },
      ],
      legend: "top",
    },
    protocol_id: null,
    created_by: priya,
    created_at: "2026-11-03T18:10:00Z",
    updated_at: "2026-11-03T18:10:00Z",
  },
  {
    // Conductivity on its own volume column, under the UV trace on the protocol page; one axis
    // each, since mS/cm and mAU don't share a scale.
    id: chartId(4),
    sha256: SEC,
    sheet: "Table 1",
    title: "Batch 3 SEC, conductivity",
    spec: {
      version: 1,
      type: "line",
      x: { column: "A", ...axis("Elution volume", "ml") },
      y: { ...axis("Conductivity", "mS/cm"), scale: "linear" },
      series: [{ column: "F", name: "Conductivity", color: "aqua", error: null, x: "E" }],
      legend: "top",
    },
    protocol_id: purification,
    created_by: ade,
    created_at: "2026-10-15T09:40:00Z",
    updated_at: "2026-10-15T09:40:00Z",
  },
  {
    id: chartId(5),
    sha256: BIOREACTOR,
    sheet: "Table 1",
    title: "Run 12 growth",
    spec: {
      version: 1,
      type: "line",
      x: { column: "A", ...axis("Timestamp", "") },
      y: { ...axis("OD600", ""), scale: "linear" },
      series: [{ column: "E", name: "OD600", color: "blue", error: null }],
      legend: "top",
    },
    protocol_id: null,
    created_by: priya,
    created_at: "2026-11-13T10:00:00Z",
    updated_at: "2026-11-13T10:00:00Z",
  },
  {
    id: chartId(6),
    sha256: ELISA,
    sheet: "Table 1",
    title: "ELISA plate 3",
    spec: {
      version: 1,
      type: "heatmap",
      plate: { size: 96, source: { kind: "wells", well: "A", value: "C" } },
      value: { title: "OD450", unit: "", min: null, max: null },
    },
    protocol_id: null,
    created_by: priya,
    created_at: "2026-11-04T11:00:00Z",
    updated_at: "2026-11-04T11:00:00Z",
  },
  {
    // Ten wells of plate 7, a row each down column 1 and two from column 12: the first six
    // solid, the next four the same hues dashed.
    id: chartId(7),
    sha256: PLATE,
    sheet: "Table 1",
    title: "Plate 7, ten wells",
    spec: {
      version: 1,
      type: "line",
      x: { column: "A", ...axis("Time", "min") },
      y: { ...axis("A420", "AU"), scale: "linear" },
      series: [
        ["C", "A1"],
        ["O", "B1"],
        ["AA", "C1"],
        ["AM", "D1"],
        ["AY", "E1"],
        ["BK", "F1"],
        ["BW", "G1"],
        ["CI", "H1"],
        ["Z", "B12"],
        ["CH", "G12"],
      ].map(([column, name], i) => ({
        column,
        name,
        color: COLORS[i % 6],
        stroke: i < 6 ? "solid" : "dashed",
        error: null,
      })),
      legend: "top",
    },
    protocol_id: null,
    created_by: priya,
    created_at: "2026-11-03T18:20:00Z",
    updated_at: "2026-11-03T18:20:00Z",
  },
  {
    id: chartId(8),
    sha256: PLATE,
    sheet: "Table 1",
    title: "Plate 7 at 30 min",
    spec: {
      version: 1,
      type: "heatmap",
      plate: { size: 96, source: { kind: "read", row: 30 } },
      value: { title: "A420", unit: "AU", min: null, max: null },
    },
    protocol_id: null,
    created_by: priya,
    created_at: "2026-11-03T18:30:00Z",
    updated_at: "2026-11-03T18:30:00Z",
  },
  {
    // Saved before the file was read again: column H isn't in Standards any more.
    id: chartId(9),
    sha256: BRADFORD,
    sheet: "Standards",
    title: "Bradford replicates",
    spec: {
      version: 1,
      type: "scatter",
      x: { column: "A", ...axis("BSA", "µg/mL") },
      y: { ...axis("A595", "AU"), scale: "linear" },
      series: [
        { column: "B", name: "Rep 1", color: "blue", error: null },
        { column: "H", name: "Rep 4", color: "orange", error: null },
      ],
      legend: "top",
    },
    protocol_id: null,
    created_by: priya,
    created_at: "2026-10-30T16:10:00Z",
    updated_at: "2026-10-30T16:10:00Z",
  },
]);

// The viability plate as a student paints it: blanks down column 1, the vehicle down column 2,
// and Drug A from 100 µM down by fives across columns 3 to 7, rows B to D.
const DRUG_PLATE = (() => {
  const blankWells = wellsBetween({ row: 1, column: 0 }, { row: 3, column: 0 });
  const controlWells = wellsBetween({ row: 1, column: 1 }, { row: 3, column: 1 });
  let layout = assignWells(emptyLayout(96, "µM"), blankWells, { role: "blank", name: "", conc: null, dilution: null });
  layout = assignWells(layout, controlWells, { role: "control", name: "", conc: 0, dilution: null });
  return fillSeries(layout, wellsBetween({ row: 1, column: 2 }, { row: 3, column: 6 }), { role: "sample", name: "Drug A", start: 100, factor: 5, direction: "across" });
})();

export const DRUG_LAYOUT_ID = "9d1c2c39-5a4e-4c55-9d7b-0c3c1a7d0001";
const BRADFORD_PROTOCOL = "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0002";
const VIABILITY_PROTOCOL = "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0019";

export const savedLayouts: SavedLayout[] = LayoutRows.parse([
  {
    id: "9d1c2c39-5a4e-4c55-9d7b-0c3c1a7d0002",
    name: "Bradford plate, 3 blanks and 5 standards in pairs",
    protocol_id: BRADFORD_PROTOCOL,
    sha256: null,
    layout: (() => {
      let l = assignWells(emptyLayout(96, "µg/mL"), ["A1", "B1", "C1"], { role: "blank", name: "", conc: null, dilution: null });
      [125, 250, 500, 750, 1000].forEach((conc, i) => {
        const at = 3 + i * 2;
        l = assignWells(l, [`${"ABCDEFGH"[at % 8]}${Math.floor(at / 8) + 1}`, `${"ABCDEFGH"[(at + 1) % 8]}${Math.floor((at + 1) / 8) + 1}`], { role: "standard", name: "", conc, dilution: null });
      });
      return l;
    })(),
    updated_at: "2026-11-01T10:00:00Z",
  },
]);

savedCharts.push(
  ...ChartRows.parse([
    {
      // The worked example, saved: the dose-response of Drug A from its painted layout.
      id: chartId(10),
      sha256: DOSE,
      sheet: "Table 1",
      title: "Drug A viability, plate 2",
      spec: {
        version: 1,
        type: "dose",
        source: { kind: "plate", plate: { kind: "grid", rows: "A" }, layout: DRUG_PLATE, layoutId: DRUG_LAYOUT_ID },
        spread: "sd",
        points: true,
        blank: true,
        fit: "points",
        x: { title: "Drug A", unit: "µM", scale: "log", min: null, max: null },
        y: { title: "A570", unit: "", scale: "linear", min: null, max: null },
      },
      protocol_id: VIABILITY_PROTOCOL,
      protocol_version_id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7b0022",
      created_by: priya,
      created_at: "2026-11-05T15:00:00Z",
      updated_at: "2026-11-05T15:04:00Z",
    },
  ]),
);

export function savedChart(n: number): SavedChart {
  const chart = savedCharts.find((c) => c.id === chartId(n));
  if (chart === undefined) throw new Error(`no fixture chart ${n}`);
  return chart;
}

export function chartsOf(sha: Sha256): SavedChart[] {
  return savedCharts.filter((c) => c.sha256 === sha);
}
