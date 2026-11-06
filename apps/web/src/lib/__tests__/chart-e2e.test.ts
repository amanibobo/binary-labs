import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChartSvg, EXPORT_INK, PlateSvg } from "@/components/charts/chart-svg";
import { ChartRows, ChartSpec, checkSpec, isXY } from "../charts";
import { startingChart } from "../chart-guide";
import { plotChart } from "../chart-geometry";
import { plotPlate } from "../plate-geometry";
import { LabId } from "../ids";

// Driven by scripts/e2e-charts.sh, which runs the real worker over five instrument exports
// first. Skipped in the normal unit run.
const env = z
  .object({ E2E_DATABASE_URL: z.string(), E2E_USER: z.string().min(1), E2E_LAB: z.string().min(1), E2E_OUT: z.string().min(1) })
  .safeParse(process.env);

vi.mock("server-only", () => ({}));

describe.runIf(env.success)("a chart from a processed file, through the routes' core", () => {
  it("reads each stored table, saves charts as a member, and exports an SVG", async () => {
    if (!env.success) return;
    const { E2E_DATABASE_URL, E2E_USER, E2E_OUT } = env.data;
    const lab = LabId.parse(env.data.E2E_LAB);
    const { readTables } = await import("../chart-store");
    const db = new Client({ connectionString: E2E_DATABASE_URL });
    await db.connect();
    const asMember = async (sql: string, params: unknown[]) => {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: E2E_USER })]);
        const res = await db.query(sql, params);
        await db.query("commit");
        return res.rows;
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    };
    try {
      const files = z
        .array(z.object({ name: z.string(), sha256: z.string(), storage_key: z.string() }))
        .parse(
          await asMember(
            `select distinct on (t.sha256) fl.original_name as name, t.sha256, t.storage_key from data_tables t
             join file_locations fl on fl.lab_id = t.lab_id and fl.sha256 = t.sha256
             where t.lab_id = $1 and t.state = 'ready' order by t.sha256`,
            [lab],
          ),
        );
      expect(files.map((f) => f.name).sort()).toEqual([
        "Bioreactor_run12.csv",
        "Bradford_2026-10-30.xlsx",
        "ELISA_plate3.csv",
        "SEC_trace_141026.csv",
        "plate7_A420.csv",
      ]);

      for (const file of files) {
        const doc = await readTables(lab, file.storage_key);
        const table = file.name.endsWith(".xlsx") ? doc.tables.find((t) => t.name === "Standards") : doc.tables[0];
        if (table === undefined) throw new Error(`no table in ${file.name}`);
        const start = startingChart(table);
        if (start === null) throw new Error(`nothing to plot in ${file.name}`);
        // The Bradford curve as a lab plots it: means with their SDs.
        const spec = file.name.endsWith(".xlsx")
          ? ChartSpec.parse({ ...start, type: "scatter", series: [{ column: "E", name: "Mean", color: "blue", error: "F" }] })
          : start;
        expect(checkSpec(spec, table)).toBeNull();
        const [saved] = ChartRows.parse(
          (
            await asMember(
              `with r as (insert into charts (lab_id, sha256, sheet, title, spec) values ($1, $2, $3, $4, $5)
               returning id, sha256, sheet, title, spec, protocol_id, created_by, created_at, updated_at)
               select to_jsonb(r) as row from r`,
              [lab, file.sha256, table.name, file.name, spec],
            )
          ).map((r: { row: unknown }) => r.row),
        );
        expect(saved?.createdBy).toBe(E2E_USER);

        // The ELISA list starts as a plate heatmap; the rest as x/y charts.
        expect(spec.type === "heatmap").toBe(file.name.startsWith("ELISA"));
        if (spec.type !== "heatmap" && !isXY(spec)) throw new Error("not a column chart");
        const svg =
          spec.type === "heatmap"
            ? renderToStaticMarkup(
                createElement(PlateSvg, { plot: plotPlate(spec, table, { width: 960, height: 560 }, { title: file.name }), ink: EXPORT_INK, gradientId: "scale", label: file.name }),
              )
            : renderToStaticMarkup(
                createElement(ChartSvg, { plot: plotChart(spec, table, { width: 960, height: 560 }, { title: file.name }), ink: EXPORT_INK, clipId: "plot", label: file.name }),
              );
        expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="960" height="\d+"/);
        if (file.name.startsWith("Bioreactor")) expect(svg).toContain(">Nov 12<");
        expect(svg).not.toContain("var(--");
        const out = join(E2E_OUT, `${file.name}.svg`);
        writeFileSync(out, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`);
      }
    } finally {
      await db.end();
    }
  });
});
