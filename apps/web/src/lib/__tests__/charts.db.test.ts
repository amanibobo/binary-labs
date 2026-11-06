import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChartRows, checkSpec, type SavedChart } from "../charts";
import { startingChart } from "../chart-guide";
import { CreateLabResult } from "../domain";
import { LabId, Sha256 } from "../ids";

vi.mock("server-only", () => ({}));
const store = mkdtempSync(join(tmpdir(), "bl-chart-store-"));
process.env.PREVIEW_STORE = "local";
process.env.PREVIEW_DIR = store;
const { readTables, tablePrefix } = await import("../chart-store");

// Charts against the real migrations, as members of two labs with RLS on: the table the worker
// stored, a chart saved from it and saved again, and what the other lab can't see.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const rosa = "00000000-0000-4000-8000-0000000000d1";
const sam = "00000000-0000-4000-8000-0000000000d2";
const sha = Sha256.parse("d".repeat(63) + "1");
const plate = readFileSync(join(__dirname, "../../fixtures/tables/plate7_A420.json"));

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

// Rows as PostgREST serializes them.
async function rows(sql: string, params: unknown[]): Promise<unknown> {
  const res = await db.query(`with r as (${sql}) select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from r`, params);
  return z.object({ rows: z.unknown() }).parse(res.rows[0]).rows;
}

const COLUMNS = "id, sha256, sheet, title, spec, protocol_id, created_by, created_at, updated_at";
let labA: LabId;
let labB: LabId;
let key: string;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'rosa@lab.test'), ($2, 'sam@lab.test') on conflict do nothing", [rosa, sam]);
  labA = LabId.parse(CreateLabResult.parse((await asUser(rosa, () => db.query("select create_lab('Charts lab A') as id"))).rows[0]?.id));
  labB = LabId.parse(CreateLabResult.parse((await asUser(sam, () => db.query("select create_lab('Charts lab B') as id"))).rows[0]?.id));
  // What the worker writes for a processed plate-reader export.
  await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 19150, 'text/csv', 'spreadsheet') on conflict do nothing", [sha]);
  const source = await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/x') returning id", [labA]);
  await db.query(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, 'plate7_A420.csv', '/plate7_A420.csv', 'plate7_A420.csv', 19150, now(), 'r1', $3, 'indexed')`,
    [labA, source.rows[0]?.id, sha],
  );
  key = `${tablePrefix(labA)}${sha}.json`;
  mkdirSync(dirname(join(store, key)), { recursive: true });
  writeFileSync(join(store, key), plate);
  await db.query("insert into data_tables (lab_id, sha256, state, parser_version, storage_key) values ($1, $2, 'ready', 1, $3)", [labA, sha, key]);
});

afterAll(async () => {
  await db.query("delete from labs where id = any($1)", [[labA, labB]]);
  await db.end();
});

describe("a chart of a stored table", () => {
  it("reads the worker's table from the lab's prefix, and nothing outside it", async () => {
    const doc = await readTables(labA, key);
    expect(doc.tables[0]?.columns).toHaveLength(98);
    await expect(readTables(labB, key)).rejects.toThrow(/outside the lab/);
  });

  it("saves, saves again on top of what it read, and refuses a save over someone else's", async () => {
    const table = (await readTables(labA, key)).tables[0];
    if (table === undefined) throw new Error("no table");
    const spec = startingChart(table);
    if (spec === null) throw new Error("nothing to plot");
    expect(checkSpec(spec, table)).toBeNull();

    const [made] = ChartRows.parse(
      await asUser(rosa, () =>
        rows(`insert into charts (lab_id, sha256, sheet, title, spec) values ($1, $2, $3, 'Plate 7', $4) returning ${COLUMNS}`, [labA, sha, table.name, spec]),
      ),
    );
    if (made === undefined) throw new Error("not saved");
    expect(made).toMatchObject({ sheet: "Table 1", title: "Plate 7", createdBy: rosa, protocolId: null });

    const save = (chart: SavedChart, title: string) =>
      asUser(rosa, () =>
        rows(`update charts set title = $3 where id = $1 and updated_at = $2 returning ${COLUMNS}`, [chart.id, chart.updatedAt, title]),
      ).then((r) => ChartRows.parse(r));
    const [second] = await save(made, "Plate 7 kinetics");
    expect(second?.title).toBe("Plate 7 kinetics");
    expect(second?.updatedAt).not.toBe(made.updatedAt);
    // The first editor still holds the old updated_at: nothing changes, which the route says is stale.
    expect(await save(made, "Mine")).toEqual([]);

    const seen = await asUser(sam, () => rows(`select ${COLUMNS} from charts`, []));
    expect(seen).toEqual([]);
    expect(await asUser(sam, () => rows("select * from data_tables", []))).toEqual([]);
  });
});
