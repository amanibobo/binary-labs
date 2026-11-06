import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AuditAction, CreateLabResult, SourceKind } from "../domain";
import type { LabId } from "../ids";
import {
  MyUploadsRows,
  RecordUploadRows,
  StartUploadRequest,
  UPLOAD_MAX_BYTES,
  uploadHeaders,
  UploadId,
  type UploadMeta,
} from "../uploads";

vi.mock("server-only", () => ({}));
const store = mkdtempSync(join(tmpdir(), "bl-store-"));
process.env.PREVIEW_STORE = "local";
process.env.PREVIEW_DIR = store;
const { completeUpload, receiveUploadBody, startUpload } = await import("../upload-accept");
const { sendUpload } = await import("./upload-through-core");
const { discardStaged } = await import("../staged-upload");

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

// The upload route's core, as a signed-in member: what a phone's request does end to end,
// short of Supabase's HTTP layer.
function recordAs(userId: string) {
  return async (args: Record<string, unknown>) => {
    try {
      const data = await asUser(userId, () =>
        rpcJson("record_upload($1, $2, $3, $4, $5, $6::date, $7::timestamptz)", [
          args.p_lab_id,
          args.p_sha256,
          args.p_size,
          args.p_name,
          args.p_experiment,
          args.p_uploaded_on,
          args.p_modified_at,
        ]),
      );
      return { data, error: null };
    } catch (err) {
      return { data: null, error: z.object({ code: z.string().optional(), message: z.string() }).parse(err) };
    }
  };
}

const meta = (m: Partial<UploadMeta> = {}) =>
  uploadHeaders({ name: "gel.png", experiment: "P450 BM3", uploadedOn: today, modifiedAt: null, ...m });

const staged = (labId: string) => {
  const dir = join(store, labId, "uploads");
  return existsSync(dir) ? readdirSync(dir) : [];
};

const never = async (): Promise<never> => {
  throw new Error("a refused upload records nothing");
};

describe("the upload routes' core", () => {
  const photo = new Uint8Array(5000).map((_, i) => (i * 31) % 251);
  const sha = createHash("sha256").update(photo).digest("hex");

  it("stores the bytes under the lab's prefix and records them once", async () => {
    const first = await sendUpload(labF, { bytes: photo, meta: meta() }, recordAs(fay));
    const again = await sendUpload(labF, { bytes: photo, meta: meta({ name: "again.png" }) }, recordAs(fay));
    if (!("receipt" in first) || !("receipt" in again)) throw new Error(`expected receipts: ${JSON.stringify([first, again])}`);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(first.receipt.sha256).toBe(sha);
    expect(again.receipt).toEqual({ ...first.receipt, duplicate: true });
    expect(new Uint8Array(readFileSync(join(store, labF, "files", sha)))).toEqual(photo);
    // The staged copies are gone once the file is recorded.
    expect(staged(labF)).toEqual([]);
  });

  it("builds every key from the session's lab and a fresh id, never from the request", async () => {
    const asked = StartUploadRequest.parse({ purpose: "file", size: 10, type: "image/png; x=1", key: `${labG}/files/x` });
    const started = await startUpload(labF, asked);
    if (!("session" in started)) throw new Error(JSON.stringify(started));
    expect(started.session.url).toBe(`/api/uploads/${started.session.uploadId}`);
    expect(started.session.headers).toEqual({ "content-type": "image/png" });
    const put = await receiveUploadBody(labF, started.session.uploadId, {
      headers: new Headers({ "content-length": "10" }),
      body: new Blob([new Uint8Array(10).fill(4)]).stream(),
    });
    expect(put).toEqual({ stored: true });
    expect(staged(labF)).toEqual([started.session.uploadId]);
    expect(existsSync(join(store, labG))).toBe(false);
    // Completing the id from another lab finds nothing: that lab's key is under that lab.
    const claim = { size: 10, sha256: null };
    const elsewhere = await completeUpload(labG, started.session.uploadId, { headers: new Headers(meta()), claim }, never);
    expect(elsewhere.status).toBe(409);
    expect(staged(labF)).toEqual([started.session.uploadId]);
    await discardStaged(labF, started.session.uploadId);
  });

  it("refuses a file whose sha256 isn't what the page sent, and drops it", async () => {
    const other = await sendUpload(labF, { bytes: photo, meta: meta(), claim: { sha256: "0".repeat(64) } }, never);
    expect(other).toEqual({ status: 422, error: "The file that arrived isn't the file that was sent. Add it again." });
    expect(staged(labF)).toEqual([]);
  });

  it("refuses a file whose stored size isn't the size the page gave, and drops it", async () => {
    const started = await startUpload(labF, { purpose: "file", size: 100, type: "image/png" });
    if (!("session" in started)) throw new Error(JSON.stringify(started));
    const { uploadId } = started.session;
    // R2 holds the PUT to its signed size; the local stand-in takes what comes, so complete checks.
    await receiveUploadBody(labF, uploadId, { headers: new Headers({ "content-length": "99" }), body: new Blob([new Uint8Array(99)]).stream() });
    const done = await completeUpload(labF, uploadId, { headers: new Headers(meta()), claim: { size: 100, sha256: null } }, never);
    expect(done).toEqual({ status: 422, error: "The file that arrived isn't the size it was said to be. Add it again." });
    expect(staged(labF)).not.toContain(uploadId);
  });

  it("refuses a complete for bytes that never arrived", async () => {
    const started = await startUpload(labF, { purpose: "file", size: 100, type: "image/png" });
    if (!("session" in started)) throw new Error(JSON.stringify(started));
    const done = await completeUpload(labF, started.session.uploadId, { headers: new Headers(meta()), claim: { size: 100, sha256: null } }, never);
    expect(done.status).toBe(409);
  });

  it("trusts its own hash when the page couldn't compute one", async () => {
    const bytes = new Uint8Array(64).fill(2);
    const done = await sendUpload(labF, { bytes, meta: meta(), claim: { sha256: null } }, recordAs(fay));
    expect("receipt" in done && done.receipt.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("refuses oversize, empty, cut-off, video and nameless uploads before recording anything", async () => {
    const big = await startUpload(labF, { purpose: "file", size: UPLOAD_MAX_BYTES + 1, type: "image/png" });
    const empty = await startUpload(labF, { purpose: "file", size: 0, type: "image/png" });
    const video = await startUpload(labF, { purpose: "file", size: 10, type: "video/mp4" });
    const cut = await receiveUploadBody(labF, UploadId.parse(randomUUID()), {
      headers: new Headers({ "content-length": "5010" }),
      body: new Blob([photo]).stream(),
    });
    const nameless = await sendUpload(labF, { bytes: photo, meta: {} }, never);
    expect([big.status, empty.status, video.status, cut, nameless.status]).toEqual([413, 400, 415, expect.objectContaining({ status: 408 }), 400]);
  });

  it("can't record into a lab the member isn't in", async () => {
    const other = new Uint8Array(100).fill(3);
    await expect(sendUpload(labG, { bytes: other, meta: meta() }, recordAs(fay))).rejects.toThrow(/42501/);
    const otherSha = createHash("sha256").update(other).digest("hex");
    expect(await asUser(gus, async () => (await db.query("select 1 from file_locations where external_id = $1", [otherSha])).rowCount)).toBe(0);
  });
});
