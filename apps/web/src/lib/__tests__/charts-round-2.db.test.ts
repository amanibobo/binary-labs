import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import linesJson from "@/fixtures/tables/viability_lines_by_day.json";
import bradfordJson from "@/fixtures/tables/Bradford_2026-11-03.json";
import { startFor } from "../chart-guide";
import { ChartSpec, isXY } from "../charts";
import { DataTables, mainTable, type DataTable } from "../data-tables";

// chart_spec_ok (0026) against ChartSpec for what round 2 adds: the heatmap of two columns, and
// a line or scatter chart that names other runs.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });

const table = (json: unknown): DataTable => {
  const t = mainTable(DataTables.parse(json));
  if (t === null) throw new Error("no table");
  return t;
};

async function specOk(spec: unknown): Promise<boolean> {
  const res = await db.query("select chart_spec_ok($1::jsonb) as ok", [JSON.stringify(spec)]);
  return res.rows[0]?.ok === true;
}

beforeAll(async () => {
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

describe("round 2 chart specs", () => {
  const run = (n: number) => n.toString(16).padStart(64, "a");

  it("pass for a heatmap of two columns and a line chart with other runs, as ChartSpec does", async () => {
    const grid = startFor(table(linesJson), "grid");
    const line = startFor(table(bradfordJson), "line");
    if (grid === null || line === null || !isXY(line)) throw new Error("no chart");
    const withRuns = { ...line, runs: [run(1), run(2)] };
    for (const spec of [grid, line, withRuns, { ...withRuns, runs: [] }]) {
      expect(ChartSpec.safeParse(spec).success).toBe(true);
      expect(await specOk(spec)).toBe(true);
    }
  });

  it("refuse what ChartSpec refuses", async () => {
    const grid = startFor(table(linesJson), "grid");
    const line = startFor(table(bradfordJson), "line");
    if (grid === null || grid.type !== "grid" || line === null || !isXY(line)) throw new Error("no chart");
    const broken = [
      { ...grid, rows: "a1" },
      { ...grid, measure: null },
      { ...grid, value: { ...grid.value, min: "low" } },
      { ...line, runs: [run(1), run(1)] },
      { ...line, runs: ["not a sha"] },
      { ...line, runs: Array.from({ length: 12 }, (_, i) => run(i + 1)) },
      { ...line, type: "bar", runs: [run(1)] },
    ];
    for (const b of broken) {
      expect([b, ChartSpec.safeParse(b).success]).toEqual([b, false]);
      expect([b, await specOk(b)]).toEqual([b, false]);
    }
  });
});
