import { ChartRows, type SavedChart } from "@/lib/charts";
import { DataTables, type TableState } from "@/lib/data-tables";
import type { FileHit } from "@/lib/domain";
import { Sha256 } from "@/lib/ids";
import { recentFiles, searchHits } from "./data";
import bradfordJson from "./tables/Bradford_2026-10-30.json";
import plateJson from "./tables/plate7_A420.json";
import secJson from "./tables/SEC_trace_141026.json";

// Dev-only chart data. The tables are the worker's own parse of the instrument exports in
// workers/tests/fixtures/tables (workers/scripts/make_table_fixtures.py writes both).

export const PLATE = Sha256.parse("1".repeat(64));
export const BRADFORD = Sha256.parse("4".repeat(64));
export const SEC = Sha256.parse("f".repeat(64));

const TABLES = new Map<Sha256, DataTables>([
  [PLATE, DataTables.parse(plateJson)],
  [BRADFORD, DataTables.parse(bradfordJson)],
  [SEC, DataTables.parse(secJson)],
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

const priya = "00000000-0000-4000-8000-00000000000b";
const ade = "00000000-0000-4000-8000-00000000000a";
const chartId = (n: number) => `8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c${String(n).padStart(4, "0")}`;
const axis = (title: string, unit: string) => ({ title, unit, min: null, max: null });

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
    protocol_id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001",
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
        { column: "D", name: "A260", color: "orange", error: null },
      ],
      legend: "top",
    },
    protocol_id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001",
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
]);

export function chartsOf(sha: Sha256): SavedChart[] {
  return savedCharts.filter((c) => c.sha256 === sha);
}
