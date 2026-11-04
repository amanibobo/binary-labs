import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditAction, CreateLabResult, SourceKind } from "../domain";
import type { LabId } from "../ids";
import { MyUploadsRows, RecordUploadRows, UPLOAD_MAX_BYTES } from "../uploads";

// record_upload and my_uploads through the web app's arguments and parsers, as the
// `authenticated` role with RLS, serializing rows with to_jsonb the way PostgREST does.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const fay = "00000000-0000-4000-8000-0000000000f1";
const gus = "00000000-0000-4000-8000-0000000000f2";
const today = new Date().toISOString().slice(0, 10);

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

async function rpcJson(sql: string, params: unknown[]): Promise<unknown> {
  const res = await db.query(`select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from ${sql} r`, params);
  return z.object({ rows: z.unknown() }).parse(res.rows[0]).rows;
}

async function sqlState(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return z.object({ code: z.string().optional() }).parse(err).code;
  }
  throw new Error("expected the call to fail");
}

const recordUpload = (userId: string, labId: LabId, sha: string, size = 10, experiment: string | null = "P450 BM3") =>
  asUser(userId, () =>
    rpcJson("record_upload($1, $2, $3, $4, $5, $6::date, $7::timestamptz)", [labId, sha, size, "gel.jpg", experiment, today, null]),
  );

let labF: LabId;
let labG: LabId;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'fay@lab.edu'), ($2, 'gus@lab.edu')", [fay, gus]);
  labF = CreateLabResult.parse(await asUser(fay, async () => (await db.query("select create_lab('Fay Lab') as id")).rows[0]?.id));
  labG = CreateLabResult.parse(await asUser(gus, async () => (await db.query("select create_lab('Gus Lab') as id")).rows[0]?.id));
});

afterAll(async () => {
  await db.end();
});

describe("uploads through the web app's parsers", () => {
  it("records an upload once, however often the same bytes arrive", async () => {
    const first = RecordUploadRows.parse(await recordUpload(fay, labF, "f".repeat(64)));
    const again = RecordUploadRows.parse(await recordUpload(fay, labF, "f".repeat(64)));
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ locationId: first.locationId, duplicate: true });

    const rows = MyUploadsRows.parse(await asUser(fay, () => rpcJson("my_uploads($1)", [labF])));
    expect(rows.map((r) => [r.locationId, r.experiment, r.progress.kind])).toEqual([[first.locationId, "P450 BM3", "reading"]]);
  });

  it("keeps each lab's uploads to itself", async () => {
    const gusUpload = RecordUploadRows.parse(await recordUpload(gus, labG, "9".repeat(64)));
    expect(await sqlState(() => recordUpload(fay, labG, "8".repeat(64)))).toBe("42501");
    await asUser(fay, async () => {
      expect(MyUploadsRows.parse(await rpcJson("my_uploads($1)", [labG]))).toEqual([]);
      // The /api/files route's lookup: a location in another lab is simply not there.
      const seen = await db.query("select 1 from file_locations where id = $1", [gusUpload.locationId]);
      expect(seen.rowCount).toBe(0);
      expect((await db.query("select 1 from uploads where lab_id = $1", [labG])).rowCount).toBe(0);
    });
  });

  it("refuses a file over the cap the route checks", async () => {
    const cap = await asUser(fay, async () => (await db.query("select upload_max_bytes() as n")).rows[0]?.n);
    expect(Number(cap)).toBe(UPLOAD_MAX_BYTES);
    expect(await sqlState(() => recordUpload(fay, labF, "7".repeat(64), UPLOAD_MAX_BYTES + 1))).toBe("BL201");
  });

  it("mirrors the database's enums", async () => {
    const values = async (type: string) =>
      z.array(z.object({ v: z.string() })).parse((await db.query(`select unnest(enum_range(null::${type}))::text as v`)).rows).map((r) => r.v);
    expect(await values("source_kind")).toEqual(SourceKind.options);
    expect(await values("audit_action")).toEqual(AuditAction.options);
  });
});
