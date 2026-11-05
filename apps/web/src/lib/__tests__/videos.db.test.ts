import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CreateLabResult, FileKind } from "../domain";
import { ProtocolId, type LabId } from "../ids";
import { partCount, partSpan, ProtocolVideosRows, VIDEO_MAX_BYTES, VIDEO_PART_BYTES, type CompleteVideoRequest, type VideoSession } from "../videos";

vi.mock("server-only", () => ({}));
const store = mkdtempSync(join(tmpdir(), "bl-video-store-"));
process.env.PREVIEW_STORE = "local";
process.env.PREVIEW_DIR = store;
const { completeVideoUpload, receiveVideoPart, startVideoUpload, videoPartUrl, abortVideoUpload } = await import("../video-upload");

// The video upload routes' core against the local store and local Postgres, as members of
// two labs with RLS on: start, parts, complete, record_video, and what the page then reads.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const vera = "00000000-0000-4000-8000-0000000000c1";
const walt = "00000000-0000-4000-8000-0000000000c2";
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

function recordAs(userId: string) {
  return async (args: Record<string, unknown>) => {
    try {
      const data = await asUser(userId, () =>
        rpcJson("record_video($1, $2, $3, $4, $5::date, $6::timestamptz, $7)", [
          args.p_lab_id,
          args.p_sha256,
          args.p_size,
          args.p_name,
          args.p_uploaded_on,
          args.p_modified_at,
          args.p_protocol_id,
        ]),
      );
      return { data, error: null };
    } catch (err) {
      return { data: null, error: z.object({ code: z.string().optional(), message: z.string() }).parse(err) };
    }
  };
}

// The page check the start route makes, with RLS, as the member.
function pageCheck(userId: string, labId: LabId) {
  return (protocolId: ProtocolId) =>
    asUser(userId, async () => {
      const res = await db.query("select archived_at from protocols where id = $1 and lab_id = $2", [protocolId, labId]);
      const row = res.rows[0];
      if (row === undefined) return "missing" as const;
      return row.archived_at === null ? ("open" as const) : ("archived" as const);
    });
}

const makePage = (userId: string, labId: LabId, title: string) =>
  asUser(userId, async () =>
    ProtocolId.parse((await db.query("select protocol_id from create_protocol($1, 'tutorial', $2, '1. Watch.')", [labId, title])).rows[0]?.protocol_id),
  );

function video(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) bytes[i] = (i / 4096 + seed) % 256;
  return bytes;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function partRequest(bytes: Uint8Array<ArrayBuffer>) {
  return { headers: new Headers({ "content-length": String(bytes.byteLength) }), body: new Blob([bytes]).stream() };
}

// What the browser does: start, then each part to where the server says, then complete.
async function send(userId: string, labId: LabId, protocolId: ProtocolId, bytes: Uint8Array<ArrayBuffer>, name = "Loading the column.mp4") {
  const started = await startVideoUpload(labId, { protocolId, name, size: bytes.byteLength, type: "video/mp4" }, pageCheck(userId, labId));
  if (!("session" in started)) return started;
  const { session } = started;
  const parts = [];
  for (let n = 1; n <= partCount(bytes.byteLength); n++) {
    const target = await videoPartUrl(labId, session, { partNumber: n, size: bytes.byteLength });
    expect(target).toEqual({ url: `/api/videos/uploads/${session.uploadId}/parts/${n}` });
    const span = partSpan(bytes.byteLength, n);
    const put = await receiveVideoPart(labId, session.uploadId, n, partRequest(bytes.slice(span.start, span.end)));
    if (!("etag" in put)) throw new Error(put.error);
    parts.push({ partNumber: n, etag: put.etag });
  }
  const req: CompleteVideoRequest = {
    protocolId,
    name,
    size: bytes.byteLength,
    type: "video/mp4",
    storeId: session.storeId,
    parts,
    uploadedOn: today,
    modifiedAt: null,
  };
  return { session, done: await completeVideoUpload(labId, session.uploadId, req, recordAs(userId)) };
}

const pageVideos = (userId: string, protocolId: ProtocolId) =>
  asUser(userId, async () => ProtocolVideosRows.parse(await rpcJson("protocol_videos($1)", [protocolId])));

let labV: LabId;
let labW: LabId;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'vera@lab.edu'), ($2, 'walt@lab.edu')", [vera, walt]);
  labV = CreateLabResult.parse(await asUser(vera, async () => (await db.query("select create_lab('Vera Lab') as id")).rows[0]?.id));
  labW = CreateLabResult.parse(await asUser(walt, async () => (await db.query("select create_lab('Walt Lab') as id")).rows[0]?.id));
});

afterAll(async () => {
  await db.end();
});

describe("a video sent in parts", () => {
  it("lands under the lab's files by the hash the server computed, and waits to join its page", async () => {
    const page = await makePage(vera, labV, "Column loading");
    const bytes = video(VIDEO_PART_BYTES + 1234, 1);
    const sent = await send(vera, labV, page, bytes);
    if (!("done" in sent) || !("receipt" in sent.done)) throw new Error(`refused: ${JSON.stringify(sent)}`);
    const { receipt, status } = sent.done;
    expect(status).toBe(201);
    expect(receipt.sha256).toBe(sha(bytes));
    expect(receipt.linked).toBe(false);

    const stored = join(store, labV, "files", receipt.sha256);
    expect(createHash("sha256").update(readFileSync(stored)).digest("hex")).toBe(receipt.sha256);
    // Staging is cleaned up: no parts and no joined copy left behind.
    expect(readdirSync(join(store, labV, "uploads"))).toEqual([]);

    const [preparing] = await pageVideos(vera, page);
    expect(preparing).toMatchObject({ state: "preparing", locationId: receipt.locationId, name: "Loading the column.mp4" });
    const path = await asUser(vera, async () => (await db.query("select path from file_locations where id = $1", [receipt.locationId])).rows[0]?.path);
    expect(path).toBe("/Uploads/Videos/Loading the column.mp4");
  });

  it("refuses a video over the cap before any bytes move, and a page from another lab", async () => {
    const page = await makePage(vera, labV, "Too long");
    const big = await startVideoUpload(labV, { protocolId: page, name: "long.mp4", size: VIDEO_MAX_BYTES + 1, type: "video/mp4" }, pageCheck(vera, labV));
    expect(big).toMatchObject({ status: 413 });
    const cap = await asUser(vera, async () => (await db.query("select video_max_bytes() as n")).rows[0]?.n);
    expect(Number(cap)).toBe(VIDEO_MAX_BYTES);

    // Walt, in his own lab, names Vera's page: the page check and record_video both refuse.
    const theirs = await startVideoUpload(labW, { protocolId: page, name: "x.mp4", size: 10, type: "video/mp4" }, pageCheck(walt, labW));
    expect(theirs).toMatchObject({ status: 404 });
    // Started for his own page, completed naming hers.
    const pageW = await makePage(walt, labW, "Walt's page");
    const bytes = video(100, 2);
    const started = await startVideoUpload(labW, { protocolId: pageW, name: "x.mp4", size: 100, type: "video/mp4" }, pageCheck(walt, labW));
    if (!("session" in started)) throw new Error("expected a session");
    const put = await receiveVideoPart(labW, started.session.uploadId, 1, partRequest(bytes));
    if (!("etag" in put)) throw new Error(put.error);
    const forged = await completeVideoUpload(
      labW,
      started.session.uploadId,
      { protocolId: page, name: "x.mp4", size: 100, type: "video/mp4", storeId: started.session.storeId, parts: [{ partNumber: 1, etag: put.etag }], uploadedOn: today, modifiedAt: null },
      recordAs(walt),
    );
    expect(forged).toEqual({ status: 404, error: "This page isn't in your lab." });
    // The bytes stayed in Walt's own lab; nothing went under Vera's.
    expect(existsSync(join(store, labW, "files", sha(bytes)))).toBe(true);
    expect(existsSync(join(store, labV, "files", sha(bytes)))).toBe(false);
  });

  it("asks for a part again when one is missing or the wrong size, and drops a cancelled upload", async () => {
    const page = await makePage(vera, labV, "Parts");
    const bytes = video(VIDEO_PART_BYTES + 10, 3);
    const started = await startVideoUpload(labV, { protocolId: page, name: "p.mp4", size: bytes.byteLength, type: "video/mp4" }, pageCheck(vera, labV));
    if (!("session" in started)) throw new Error("expected a session");
    const session: VideoSession = started.session;
    await receiveVideoPart(labV, session.uploadId, 1, partRequest(bytes.slice(0, VIDEO_PART_BYTES)));
    // Part 2 arrived short (a dropped connection the client didn't notice).
    await receiveVideoPart(labV, session.uploadId, 2, partRequest(bytes.slice(VIDEO_PART_BYTES, VIDEO_PART_BYTES + 3)));
    const req = {
      protocolId: page,
      name: "p.mp4",
      size: bytes.byteLength,
      type: "video/mp4" as const,
      storeId: session.storeId,
      parts: [
        { partNumber: 1, etag: '"1"' },
        { partNumber: 2, etag: '"2"' },
      ],
      uploadedOn: today,
      modifiedAt: null,
    };
    expect(await completeVideoUpload(labV, session.uploadId, req, recordAs(vera))).toMatchObject({ status: 400 });
    expect(await completeVideoUpload(labV, session.uploadId, { ...req, parts: req.parts.slice(0, 1) }, recordAs(vera))).toMatchObject({
      status: 400,
    });
    // A part larger than a part is refused as it arrives.
    expect(await receiveVideoPart(labV, session.uploadId, 2, partRequest(new Uint8Array(VIDEO_PART_BYTES + 1)))).toMatchObject({ status: 413 });

    await receiveVideoPart(labV, session.uploadId, 2, partRequest(bytes.slice(VIDEO_PART_BYTES)));
    await abortVideoUpload(labV, session);
    expect(existsSync(join(store, labV, "uploads", `${session.uploadId}.parts`))).toBe(false);
  });

  it("completes again after a failure past the join, from the parts it kept", async () => {
    const page = await makePage(vera, labV, "Retried");
    const bytes = video(VIDEO_PART_BYTES + 99, 5);
    const started = await startVideoUpload(labV, { protocolId: page, name: "r.mp4", size: bytes.byteLength, type: "video/mp4" }, pageCheck(vera, labV));
    if (!("session" in started)) throw new Error("expected a session");
    const { uploadId, storeId } = started.session;
    const parts = [];
    for (let n = 1; n <= 2; n++) {
      const span = partSpan(bytes.byteLength, n);
      const put = await receiveVideoPart(labV, uploadId, n, partRequest(bytes.slice(span.start, span.end)));
      if (!("etag" in put)) throw new Error(put.error);
      parts.push({ partNumber: n, etag: put.etag });
    }
    const req = { protocolId: page, name: "r.mp4", size: bytes.byteLength, type: "video/mp4" as const, storeId, parts, uploadedOn: today, modifiedAt: null };
    const flaky = async () => ({ data: null, error: { code: "08006", message: "connection lost" } });
    await expect(completeVideoUpload(labV, uploadId, req, flaky)).rejects.toThrow(/connection lost/);
    const done = await completeVideoUpload(labV, uploadId, req, recordAs(vera));
    expect(done).toMatchObject({ status: 201, receipt: { sha256: sha(bytes) } });
    expect(readdirSync(join(store, labV, "uploads"))).toEqual([]);
  });

  it("links the same bytes at once when the lab already holds them verified", async () => {
    const page = await makePage(vera, labV, "Again");
    const bytes = video(5000, 4);
    const first = await send(vera, labV, page, bytes);
    if (!("done" in first) || !("receipt" in first.done)) throw new Error("expected a receipt");
    // What the worker does once it has hashed the stored bytes.
    await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 5000, 'video/mp4', 'video')", [first.done.receipt.sha256]);
    await db.query("update file_locations set sha256 = $1 where id = $2", [first.done.receipt.sha256, first.done.receipt.locationId]);
    const other = await makePage(vera, labV, "Another page");
    const again = await send(vera, labV, other, bytes);
    if (!("done" in again) || !("receipt" in again.done)) throw new Error("expected a receipt");
    expect(again.done).toMatchObject({ status: 200, receipt: { duplicate: true, linked: true } });
    const [ready] = await pageVideos(vera, other);
    expect(ready).toMatchObject({ state: "ready", sha256: first.done.receipt.sha256, mime: "video/mp4", transcript: { kind: "waiting" } });
    // Walt can't see Vera's page's videos.
    expect(await pageVideos(walt, other)).toEqual([]);
  });

  it("mirrors the file kinds", async () => {
    const res = await db.query("select unnest(enum_range(null::file_kind))::text as v");
    expect(z.array(z.object({ v: z.string() })).parse(res.rows).map((r) => r.v)).toEqual(FileKind.options);
  });
});
