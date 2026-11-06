import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ChartSpec, checkSpec } from "../charts";
import { openTarget } from "../format";
import { FileLocation } from "../domain";
import { LabId } from "../ids";

// Run by hand against a database that `bl demo-lab` filled (local Postgres and a local store),
// with E2E_DATABASE_URL, E2E_USER (the demo's admin), E2E_OTHER (anyone else), E2E_LAB and
// PREVIEW_STORE=local PREVIEW_DIR=<the worker's store>. Skipped in the normal unit run. There's
// no Supabase here, so the session is the one stand-in: the route's query runs as the viewer
// through RLS, the way PostgREST would run it.
const env = z
  .object({ E2E_DATABASE_URL: z.string(), E2E_USER: z.string().min(1), E2E_OTHER: z.string().min(1), E2E_LAB: z.string().min(1) })
  .safeParse(process.env);

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => undefined }));
vi.mock("@/lib/audit", () => ({ auditQuietly: async () => undefined, audit: async () => undefined }));

const viewer = { id: "" };
const db = env.success ? new Client({ connectionString: env.data.E2E_DATABASE_URL }) : null;

async function asViewer(sql: string, params: unknown[]): Promise<unknown[]> {
  if (db === null) throw new Error("no database");
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: viewer.id })]);
    const res = await db.query(sql, params);
    await db.query("commit");
    return res.rows;
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
}

// The one query the files route makes: file_locations with sources!inner(kind) and blobs(mime).
function fakeSupabase() {
  return {
    from(table: string) {
      expect(table).toBe("file_locations");
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => ((filters[column] = value), builder),
        is: () => builder,
        limit: () => builder,
        then: (resolve: (r: { data: unknown; error: null }) => void, reject: (e: unknown) => void) =>
          asViewer(
            `select fl.external_id, fl.source_rev, fl.original_name, fl.source_id,
               jsonb_build_object('kind', s.kind) as sources,
               case when b.sha256 is null then null else jsonb_build_object('mime', b.mime) end as blobs
             from file_locations fl join sources s on s.id = fl.source_id left join blobs b on b.sha256 = fl.sha256
             where fl.id = $1 and fl.lab_id = $2 and fl.deleted_at is null limit 1`,
            [filters.id, filters.lab_id],
          ).then((data) => resolve({ data, error: null }), reject),
      };
      return builder;
    },
  };
}

vi.mock("@/lib/route-auth", () => ({
  routeAccess: async () => ({
    kind: "allowed",
    member: { supabase: fakeSupabase(), lab: { id: process.env.E2E_LAB, name: "Okafor Lab (demo)", role: "admin" }, user: { id: viewer.id } },
  }),
}));

describe.runIf(env.success)("the demo lab in the web app", () => {
  beforeAll(async () => db?.connect());
  afterAll(async () => db?.end());

  const open = async (locationId: string) => {
    const { GET } = await import("@/app/api/files/[id]/route");
    return GET(new NextRequest(`http://localhost/api/files/${locationId}`), { params: Promise.resolve({ id: locationId }) });
  };

  it("opens stored files from every source through the files route", async () => {
    if (!env.success) return;
    viewer.id = env.data.E2E_USER;
    const rows = z
      .array(z.object({ id: z.string(), source_id: z.string(), source_kind: z.string(), path: z.string(), original_name: z.string(), modified_at: z.string(), sha256: z.string() }))
      .parse(
        await asViewer(
          `select distinct on (s.kind) fl.id, fl.source_id, s.kind as source_kind, fl.path, fl.original_name,
             to_json(fl.modified_at) #>> '{}' as modified_at, fl.sha256
           from file_locations fl join sources s on s.id = fl.source_id
           where fl.lab_id = $1 and fl.index_state = 'indexed'
           order by s.kind, fl.path = '/AB/P450/batch3/final_v2_REAL.xlsx' desc, fl.path`,
          [env.data.E2E_LAB],
        ),
      );
    expect(rows.map((r) => r.source_kind)).toEqual(["upload", "instrument", "import"]);
    for (const row of rows) {
      const target = openTarget(FileLocation.parse(row));
      expect(target).toEqual({ href: `/api/files/${row.id}`, label: "Open file" });
      const res = await open(row.id);
      const bytes = Buffer.from(await res.arrayBuffer());
      process.stdout.write(`${row.source_kind} ${row.path}: ${res.status} ${res.headers.get("content-type")} ${bytes.length} bytes\n`);
      expect(res.status).toBe(200);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.sha256);
    }

    // Someone outside the lab gets nothing, whatever lab the session claims.
    viewer.id = env.data.E2E_OTHER;
    expect((await open(rows[0]!.id)).status).toBe(404);
  });

  it("reads each chart's table from the store, and every spec fits it", async () => {
    if (!env.success) return;
    viewer.id = env.data.E2E_USER;
    const lab = LabId.parse(env.data.E2E_LAB);
    const { readTables } = await import("../chart-store");
    const charts = z
      .array(z.object({ title: z.string(), sheet: z.string(), spec: z.unknown(), storage_key: z.string(), protocol: z.string().nullable() }))
      .parse(
        await asViewer(
          `select c.title, c.sheet, c.spec, t.storage_key,
             (select v.title from protocols p join protocol_versions v on v.id = p.current_version_id where p.id = c.protocol_id) as protocol
           from charts c join data_tables t on t.lab_id = c.lab_id and t.sha256 = c.sha256
           where c.lab_id = $1 and t.state = 'ready' order by c.title`,
          [lab],
        ),
      );
    expect(charts.length).toBe(3);
    for (const chart of charts) {
      const doc = await readTables(lab, chart.storage_key);
      const table = doc.tables.find((t) => t.name === chart.sheet);
      if (table === undefined) throw new Error(`no table ${chart.sheet} for ${chart.title}`);
      expect(checkSpec(ChartSpec.parse(chart.spec), table)).toBeNull();
      process.stdout.write(`${chart.title}: ${table.name}, ${table.rows} rows, ${table.columns.length} columns, page ${chart.protocol ?? "none"}\n`);
    }
  });
});
