import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import type { LabId } from "../ids";
import { INSTRUMENT_MAX_BYTES, LabInstrumentsRows } from "../instruments";
import { PART_BYTES, partCount, partSpan } from "../parts";
import { pgInstrumentDb } from "./pg-instrument-db";

vi.mock("server-only", () => ({}));
const store = mkdtempSync(join(tmpdir(), "bl-instrument-store-"));
process.env.PREVIEW_STORE = "local";
process.env.PREVIEW_DIR = store;
const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
vi.doMock("@/lib/instrument-db", () => ({ instrumentDb: () => pgInstrumentDb(db) }));

// The uploader's real route handlers, on the local store and local Postgres with only the
// database client swapped: pairing, the token, check, parts, complete, and what lands where.
const pair = await import("@/app/api/instruments/pair/route");
const heartbeat = await import("@/app/api/instruments/heartbeat/route");
const check = await import("@/app/api/instruments/files/check/route");
const uploads = await import("@/app/api/instruments/uploads/route");
const parts = await import("@/app/api/instruments/uploads/[id]/parts/[n]/route");
const complete = await import("@/app/api/instruments/uploads/[id]/complete/route");
const { newPairingCode } = await import("../instrument-upload");

const ana = "00000000-0000-4000-8000-0000000000d1";
const ben = "00000000-0000-4000-8000-0000000000d2";
let labA: LabId;
let labB: LabId;

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

async function addInstrument(userId: string, labId: LabId, name: string) {
  const { code, hash } = newPairingCode();
  const id = await asUser(userId, async () => {
    const res = await db.query("select instrument_id from create_instrument($1, $2, $3)", [labId, name, hash]);
    return z.string().parse(res.rows[0]?.instrument_id);
  });
  return { id, code };
}

type Call = { token?: string; body?: unknown; raw?: Uint8Array<ArrayBuffer>; headers?: Record<string, string>; method?: string };

function request(path: string, { token, body, raw, headers = {}, method = "POST" }: Call): NextRequest {
  const h = new Headers(headers);
  if (token !== undefined) h.set("authorization", `Bearer ${token}`);
  if (body !== undefined) h.set("content-type", "application/json");
  if (raw !== undefined) h.set("content-length", String(raw.byteLength));
  return new NextRequest(`http://uploader.test${path}`, {
    method,
    headers: h,
    body: raw !== undefined ? new Blob([raw]).stream() : body !== undefined ? JSON.stringify(body) : undefined,
    duplex: raw !== undefined ? "half" : undefined,
  });
}

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

async function answer(res: Response) {
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : null, etag: res.headers.get("etag") };
}

async function pairWith(code: string, client = "203.0.113.7") {
  const res = await pair.POST(request("/api/instruments/pair", { body: { code }, headers: { "x-forwarded-for": client } }));
  return answer(res);
}

async function paired(userId: string, labId: LabId, name: string) {
  const { id, code } = await addInstrument(userId, labId, name);
  const done = await pairWith(code);
  return { id, token: z.object({ token: z.string() }).parse(done.body).token };
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function bytesOf(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1024) bytes[i] = (i / 1024 + seed) % 256;
  return bytes;
}

// What the uploader does: check, start, each part to where the server says, complete.
async function send(token: string, path: string, bytes: Uint8Array<ArrayBuffer>, claim: { sha256?: string; size?: number } = {}) {
  const file = { path, sha256: claim.sha256 ?? sha(bytes), size: claim.size ?? bytes.byteLength, modifiedAt: Date.parse("2026-11-03T10:00:00Z") };
  const checked = await answer(await check.POST(request("/api/instruments/files/check", { token, body: file })));
  if (checked.status !== 200 || checked.body.have === true) return { checked };
  const started = await answer(await uploads.POST(request("/api/instruments/uploads", { token, body: file })));
  const session = z.object({ uploadId: z.string(), storeId: z.string(), partBytes: z.number(), parts: z.number() }).parse(started.body);
  const sent = [];
  for (let n = 1; n <= partCount(bytes.byteLength); n++) {
    const params = { id: session.uploadId, n: String(n) };
    const target = await answer(
      await parts.POST(request(`/x`, { token, body: { storeId: session.storeId, size: file.size } }), ctx(params)),
    );
    const span = partSpan(bytes.byteLength, n);
    const put = await answer(await parts.PUT(request(target.body.url, { token, raw: bytes.slice(span.start, span.end), method: "PUT" }), ctx(params)));
    sent.push({ partNumber: n, etag: z.string().parse(put.etag) });
  }
  const done = await answer(
    await complete.POST(request("/x", { token, body: { ...file, storeId: session.storeId, parts: sent } }), ctx({ id: session.uploadId })),
  );
  return { checked, session, done };
}

const locations = async (token: string) =>
  (
    await db.query(
      "select fl.lab_id, fl.path, fl.source_rev, fl.index_state from file_locations fl join instruments i on i.source_id = fl.source_id" +
        " where i.token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex') order by fl.path",
      [token],
    )
  ).rows;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'ana@a.test'), ($2, 'ben@b.test') on conflict do nothing", [ana, ben]);
  const make = (user: string, name: string) =>
    asUser(user, async () => CreateLabResult.parse((await db.query("select create_lab($1) as id", [name])).rows[0]?.id));
  labA = await make(ana, "Instrument lab A");
  labB = await make(ben, "Instrument lab B");
});

afterAll(async () => {
  await db.end();
});

describe("pairing", () => {
  it("trades a fresh code for a token once, and refuses wrong, used and expired codes", async () => {
    const { id, code } = await addInstrument(ana, labA, "Plate reader, room 214");
    expect((await pairWith("ZZZZ-ZZZZ")).status).toBe(401);
    const first = await pairWith(` ${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `);
    expect(first).toMatchObject({ status: 200, body: { instrument: { id, name: "Plate reader, room 214" }, lab: { name: "Instrument lab A" } } });
    expect(first.body.token).toMatch(/^blu_[A-Za-z0-9_-]{43}$/);
    expect((await pairWith(code)).status).toBe(401);

    const late = await addInstrument(ana, labA, "NanoDrop");
    await db.query("update instruments set pairing_expires_at = now() - interval '1 second' where id = $1", [late.id]);
    expect((await pairWith(late.code)).status).toBe(401);
    const stored = await db.query("select token_hash from instruments where id = $1", [id]);
    expect(stored.rows[0]?.token_hash).toBe(sha(new TextEncoder().encode(first.body.token)));
  });

  it("stops a caller after ten wrong codes but not someone else", async () => {
    const { code } = await addInstrument(ana, labA, "qPCR");
    for (let i = 0; i < 10; i++) expect((await pairWith(`WRNG${String(i).padStart(4, "0")}`, "198.51.100.9")).status).toBe(401);
    expect(await pairWith(code, "198.51.100.9")).toMatchObject({ status: 429 });
    expect((await pairWith(code, "192.0.2.44")).status).toBe(200);
  });
});

describe("the device token", () => {
  it("is the only way in: no session cookie or other bearer works, and a revoked token stops", async () => {
    const { id, token } = await paired(ana, labA, "Spectrophotometer");
    const beat = (call: Call) => heartbeat.POST(request("/api/instruments/heartbeat", { body: {}, ...call })).then(answer);
    expect(await beat({ token })).toMatchObject({ status: 200, body: { instrument: { id }, maxBytes: INSTRUMENT_MAX_BYTES, partBytes: PART_BYTES } });
    expect((await beat({})).status).toBe(401);
    expect((await beat({ headers: { cookie: "sb-access-token=eyJhbGciOiJIUzI1NiJ9.e30.x" } })).status).toBe(401);
    expect((await beat({ token: "eyJhbGciOiJIUzI1NiJ9.e30.x" })).status).toBe(401);
    expect((await beat({ token: `${token}x` })).status).toBe(401);

    const listed = LabInstrumentsRows.parse(
      await asUser(ana, async () => (await db.query("select coalesce(jsonb_agg(to_jsonb(r)), '[]') as rows from lab_instruments($1) r", [labA])).rows[0]?.rows),
    );
    expect(listed.find((i) => i.id === id)?.state).toMatchObject({ kind: "paired", seenSecondsAgo: 0 });

    await asUser(ana, () => db.query("select revoke_instrument($1)", [id]));
    expect((await beat({ token })).status).toBe(401);
    expect((await send(token, "Exports/a.csv", bytesOf(10, 1))).checked.status).toBe(401);
  });
});

describe("sending files", () => {
  it("joins the parts, checks the hash on the server and records the file on its own instrument", async () => {
    const { token } = await paired(ana, labA, "Plate reader");
    const bytes = bytesOf(PART_BYTES + 777, 2);
    const { checked, done } = await send(token, "Exports/P450/plate07.csv", bytes);
    expect(checked.body).toEqual({ have: false });
    expect(done).toMatchObject({ status: 201, body: { duplicate: false } });
    expect(await locations(token)).toEqual([
      { lab_id: labA, path: "/Instruments/Plate reader/Exports/P450/plate07.csv", source_rev: sha(bytes), index_state: "pending" },
    ]);
    expect(existsSync(join(store, labA, "files", sha(bytes)))).toBe(true);
    expect(readdirSync(join(store, labA, "uploads"))).toEqual([]);
  });

  it("dedupes by sha256 within the lab, never across labs", async () => {
    const reader = await paired(ana, labA, "Fluorimeter");
    const other = await paired(ana, labA, "Gel imager");
    const elsewhere = await paired(ben, labB, "Fluorimeter");
    const bytes = bytesOf(5000, 3);
    expect((await send(reader.token, "Runs/r1.csv", bytes)).done?.status).toBe(201);
    expect((await send(reader.token, "Runs/r1.csv", bytes)).checked.body).toEqual({ have: true });
    expect((await send(other.token, "Copies/r1.csv", bytes)).checked.body).toEqual({ have: true });
    expect((await locations(other.token)).map((l) => l.path)).toEqual(["/Instruments/Gel imager/Copies/r1.csv"]);
    const crossLab = await send(elsewhere.token, "Runs/r1.csv", bytes);
    expect(crossLab.checked.body).toEqual({ have: false });
    expect(crossLab.done?.status).toBe(201);
    expect((await locations(elsewhere.token))[0]?.lab_id).toBe(labB);
  });

  it("refuses bytes that don't match the claimed sha256 or size, and keeps nothing", async () => {
    const { token } = await paired(ana, labA, "HPLC");
    const bytes = bytesOf(3000, 4);
    expect((await send(token, "Runs/bad-hash.csv", bytes, { sha256: "0".repeat(64) })).done?.status).toBe(422);
    expect((await send(token, "Runs/bad-size.csv", bytes, { size: 3001 })).done?.status).toBeGreaterThanOrEqual(400);
    expect(await locations(token)).toEqual([]);
    expect(existsSync(join(store, labA, "files", "0".repeat(64)))).toBe(false);
  });

  it("refuses a file over the cap before anything is sent", async () => {
    const { token } = await paired(ana, labA, "Microscope");
    const big = { path: "Stacks/a.czi", sha256: "a".repeat(64), size: INSTRUMENT_MAX_BYTES + 1, modifiedAt: null };
    expect((await check.POST(request("/x", { token, body: big }))).status).toBe(413);
    expect((await uploads.POST(request("/x", { token, body: big }))).status).toBe(413);
    const { rows } = await db.query("select instrument_max_bytes() as n");
    expect(Number(rows[0]?.n)).toBe(INSTRUMENT_MAX_BYTES);
  });

  it("builds every key from the token's lab, so another lab's token never reaches this upload", async () => {
    const mine = await paired(ana, labA, "Plate washer");
    const theirs = await paired(ben, labB, "Plate washer");
    const bytes = bytesOf(2000, 5);
    const file = { path: "Runs/w.csv", sha256: sha(bytes), size: bytes.byteLength, modifiedAt: null };
    const started = z.object({ uploadId: z.string(), storeId: z.string() }).parse(
      (await answer(await uploads.POST(request("/x", { token: mine.token, body: file })))).body,
    );
    const params = { id: started.uploadId, n: "1" };
    const put = await parts.PUT(request("/x", { token: theirs.token, raw: bytes, method: "PUT" }), ctx(params));
    expect(put.status).toBe(200);
    expect(existsSync(join(store, labB, "uploads", `${started.uploadId}.parts`))).toBe(true);
    expect(existsSync(join(store, labA, "uploads", `${started.uploadId}.parts`, "1"))).toBe(false);
    const done = await complete.POST(
      request("/x", { token: theirs.token, body: { ...file, storeId: started.storeId, parts: [{ partNumber: 1, etag: "x" }] } }),
      ctx({ id: started.uploadId }),
    );
    expect(done.status).toBe(201);
    expect(await locations(mine.token)).toEqual([]);
    expect((await locations(theirs.token))[0]?.lab_id).toBe(labB);
  });
});
