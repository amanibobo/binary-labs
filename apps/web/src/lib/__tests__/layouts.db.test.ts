import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import bradfordPlateJson from "@/fixtures/tables/Bradford_plate_2026-11-05.json";
import cellsJson from "@/fixtures/tables/cell_sizes.json";
import growthJson from "@/fixtures/tables/growth_curve.json";
import knockdownJson from "@/fixtures/tables/knockdown_qpcr.json";
import pendulumJson from "@/fixtures/tables/pendulum.json";
import groupsJson from "@/fixtures/tables/treatments_4groups.json";
import doseJson from "@/fixtures/tables/viability_drugA_layout.json";
import { ChartSpec } from "../charts";
import { DataTables, mainTable } from "../data-tables";
import { CreateLabResult } from "../domain";
import { LabId } from "../ids";
import { emptyLayout, fillSeries, layoutFromFile, LayoutRows, SampleLayout, wellsBetween } from "../layouts";
import { KINDS, startKind, type ChartData } from "../summary-guide";

// Saved plate layouts and the specs of charts of repeats against the real migrations
// (db/migrations/0023_layouts.sql), as members of two labs with RLS on.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const rosa = "00000000-0000-4000-8000-0000000003d1";
const sam = "00000000-0000-4000-8000-0000000003d2";
const sha = "c".repeat(62) + "d3";

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
    const out = await fn();
    await db.query("commit");
    return out;
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
}

async function rows(sql: string, params: unknown[]): Promise<unknown> {
  const res = await db.query(`with r as (${sql}) select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from r`, params);
  return z.object({ rows: z.unknown() }).parse(res.rows[0]).rows;
}

const COLUMNS = "id, name, protocol_id, sha256, layout, created_by, created_at, updated_at";
const drugPlate = fillSeries(emptyLayout(96, "µM"), wellsBetween({ row: 1, column: 2 }, { row: 3, column: 6 }), { role: "sample", name: "Drug A", start: 100, factor: 5, direction: "across" });
let labA: LabId;
let labB: LabId;
let bradford: string;
let bradfordVersion: string;

const codeOf = (e: unknown) => z.object({ code: z.string() }).parse(e).code;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'rosa.layouts@lab.test'), ($2, 'sam.layouts@lab.test') on conflict do nothing", [rosa, sam]);
  labA = LabId.parse(CreateLabResult.parse((await asUser(rosa, () => db.query("select create_lab('Layouts lab A') as id"))).rows[0]?.id));
  labB = LabId.parse(CreateLabResult.parse((await asUser(sam, () => db.query("select create_lab('Layouts lab B') as id"))).rows[0]?.id));
  await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 900, 'text/csv', 'spreadsheet') on conflict do nothing", [sha]);
  const source = await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/x') returning id", [labA]);
  await db.query(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, 'plate.csv', '/plate.csv', 'viability_drugA.csv', 900, now(), 'r1', $3, 'indexed')`,
    [labA, source.rows[0]?.id, sha],
  );
  const created = await asUser(rosa, () => db.query("select * from create_protocol($1, 'protocol', 'Bradford assay', 'Read at 595 nm.')", [labA]));
  bradford = z.string().parse(created.rows[0]?.protocol_id);
  bradfordVersion = z.string().parse(created.rows[0]?.version_id);
});

afterAll(async () => {
  await db.query("delete from labs where id = any($1)", [[labA, labB]]);
  await db.query("delete from blobs where sha256 = $1", [sha]);
  await db.end();
});

describe("saved layouts", () => {
  it("are saved on a protocol by a member, read back as the zod shape, and audited", async () => {
    const saved = LayoutRows.parse(
      await asUser(rosa, () =>
        rows(`insert into sample_layouts (lab_id, name, protocol_id, sha256, layout) values ($1, '  Drug A plate ', $2, $3, $4) returning ${COLUMNS}`, [labA, bradford, sha, drugPlate]),
      ),
    );
    expect(saved[0]?.name).toBe("Drug A plate");
    expect(saved[0]?.layout).toEqual(drugPlate);
    const audit = await db.query("select action from audit_log where lab_id = $1 and target = $2", [labA, saved[0]?.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["layout.create"]);
  });

  it("are found again by protocol for its next plate", async () => {
    const found = LayoutRows.parse(await asUser(rosa, () => rows(`select ${COLUMNS} from sample_layouts where lab_id = $1 and protocol_id = $2`, [labA, bradford])));
    expect(found.map((l) => l.name)).toEqual(["Drug A plate"]);
  });

  it("are another lab's business only: invisible, and can't be written into", async () => {
    expect(await asUser(sam, () => rows("select id from sample_layouts where lab_id = $1", [labA]))).toEqual([]);
    await expect(asUser(sam, () => db.query("insert into sample_layouts (lab_id, name, layout) values ($1, 'x', $2)", [labA, drugPlate]))).rejects.toThrow(/row-level security/);
    const updated = await asUser(sam, () => db.query("update sample_layouts set name = 'mine' where lab_id = $1", [labA]));
    expect(updated.rowCount).toBe(0);
    const deleted = await asUser(sam, () => db.query("delete from sample_layouts where lab_id = $1", [labA]));
    expect(deleted.rowCount).toBe(0);
  });

  it("refuse another lab's protocol and file, and wells the zod schema refuses", async () => {
    const bad = (layout: unknown) => asUser(sam, () => db.query("insert into sample_layouts (lab_id, name, layout) values ($1, 'x', $2)", [labB, layout]));
    await expect(asUser(sam, () => db.query("insert into sample_layouts (lab_id, name, protocol_id, layout) values ($1, 'x', $2, $3)", [labB, bradford, drugPlate]))).rejects.toSatisfy(
      (e: unknown) => codeOf(e) === "BL103" || codeOf(e) === "23503",
    );
    await expect(asUser(sam, () => db.query("insert into sample_layouts (lab_id, name, sha256, layout) values ($1, 'x', $2, $3)", [labB, sha, drugPlate]))).rejects.toSatisfy((e: unknown) => codeOf(e) === "BL104");
    const twice = { size: 96, unit: "", groups: [{ role: "blank", name: "", conc: null, dilution: null, wells: ["A1", "A1"] }] };
    const offPlate = { size: 96, unit: "", groups: [{ role: "blank", name: "", conc: null, dilution: null, wells: ["I1"] }] };
    const role = { size: 96, unit: "", groups: [{ role: "unknown", name: "", conc: null, dilution: null, wells: ["A1"] }] };
    for (const layout of [twice, offPlate, role]) {
      expect(SampleLayout.safeParse(layout).success).toBe(false);
      await expect(bad(layout)).rejects.toSatisfy((e: unknown) => codeOf(e) === "23514");
    }
    // A 384-well layout takes P24.
    const big = { size: 384, unit: "", groups: [{ role: "sample", name: "x", conc: null, dilution: null, wells: ["P24"] }] };
    expect(SampleLayout.safeParse(big).success).toBe(true);
    await bad(big);
  });

  it("can't be moved to another lab, and members can't write who made them", async () => {
    await asUser(rosa, () => db.query("update sample_layouts set name = 'Drug A, plate 2' where lab_id = $1", [labA]));
    const [row] = z.array(z.object({ lab_id: z.string(), name: z.string() })).parse(await rows("select lab_id, name from sample_layouts where name = 'Drug A, plate 2'", []));
    expect(row?.lab_id).toBe(labA);
    await expect(asUser(rosa, () => db.query("update sample_layouts set created_by = $2 where lab_id = $1", [labA, sam]))).rejects.toThrow(/permission denied/);
  });

  it("go when the lab goes, counted by deletion's table list", async () => {
    const lab = LabId.parse(CreateLabResult.parse((await asUser(sam, () => db.query("select create_lab('Layouts doomed lab') as id"))).rows[0]?.id));
    await asUser(sam, () => db.query("insert into sample_layouts (lab_id, name, layout) values ($1, 'x', $2)", [lab, drugPlate]));
    await db.query("delete from labs where id = $1", [lab]);
    expect((await db.query("select count(*)::int as n from sample_layouts where lab_id = $1", [lab])).rows[0]?.n).toBe(0);
    // Taking a lab's layouts with it isn't someone deleting a layout.
    expect((await db.query("select count(*)::int as n from audit_log where action = 'layout.delete' and lab_id = $1", [lab])).rows[0]?.n).toBe(0);
  });
});

describe("chart specs of repeats", () => {
  const fixtures = { bradfordPlateJson, cellsJson, growthJson, knockdownJson, pendulumJson, groupsJson, doseJson };
  it("pass chart_spec_ok for every kind every fixture starts as, as ChartSpec does", async () => {
    let checked = 0;
    for (const json of Object.values(fixtures)) {
      const doc = DataTables.parse(json);
      const table = mainTable(doc);
      if (table === null) continue;
      const found = layoutFromFile(doc, table);
      const data: ChartData = { table, tables: doc.tables, layout: found === null ? null : { ...found, layoutId: null } };
      for (const kind of KINDS) {
        const spec = startKind(data, kind);
        if (spec === null) continue;
        expect(ChartSpec.safeParse(spec).success).toBe(true);
        const ok = await db.query("select chart_spec_ok($1::jsonb) as ok", [JSON.stringify(spec)]);
        expect([kind, ok.rows[0]?.ok]).toEqual([kind, true]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(12);
  });

  it("refuse what ChartSpec refuses", async () => {
    const doc = DataTables.parse(doseJson);
    const table = mainTable(doc);
    if (table === null) throw new Error("no table");
    const found = layoutFromFile(doc, table);
    const spec = startKind({ table, tables: doc.tables, layout: found === null ? null : { ...found, layoutId: null } }, "dose");
    if (spec === null || spec.type !== "dose") throw new Error("no dose chart");
    const broken = [
      { ...spec, x: { ...spec.x, scale: "linear" } },
      { ...spec, spread: "range" },
      { ...spec, fit: "spline" },
      { ...spec, points: "yes" },
      { ...spec, source: { ...spec.source, layout: { ...drugPlate, size: 48 } } },
    ];
    for (const b of broken) {
      expect(ChartSpec.safeParse(b).success).toBe(false);
      expect((await db.query("select chart_spec_ok($1::jsonb) as ok", [JSON.stringify(b)])).rows[0]?.ok).toBe(false);
    }
  });

  it("save with the protocol version the chart was saved on, set by the database", async () => {
    const doc = DataTables.parse(doseJson);
    const table = mainTable(doc);
    if (table === null) throw new Error("no table");
    const spec = startKind({ table, tables: doc.tables, layout: { layout: drugPlate, layoutId: null, from: "" } }, "dose");
    const [chart] = z.array(z.object({ id: z.string(), protocol_version_id: z.string().nullable() })).parse(
      await asUser(rosa, () => rows("insert into charts (lab_id, sha256, sheet, title, spec, protocol_id) values ($1, $2, 'Table 1', 'Drug A', $3, $4) returning id, protocol_version_id", [labA, sha, spec, bradford])),
    );
    expect(chart?.protocol_version_id).toBe(bradfordVersion);
    await expect(asUser(rosa, () => db.query("update charts set protocol_version_id = null where id = $1", [chart?.id]))).rejects.toThrow(/permission denied/);
    // Saved again off the protocol, it no longer names a version.
    const [off] = z.array(z.object({ protocol_version_id: z.string().nullable() })).parse(await asUser(rosa, () => rows("update charts set protocol_id = null where id = $1 returning protocol_version_id", [chart?.id])));
    expect(off?.protocol_version_id).toBeNull();
  });
});
