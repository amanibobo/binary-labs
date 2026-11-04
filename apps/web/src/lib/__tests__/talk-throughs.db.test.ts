import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CreateLabResult, FileKind } from "../domain";
import type { LabId } from "../ids";
import { SavedVersionRows } from "../protocols";
import {
  AUDIO_MAX_BYTES,
  OpenTalkThroughRows,
  talkThroughHeaders,
  TalkThroughRows,
  type TalkThroughMeta,
} from "../talk-throughs";
import { uploadHeaders } from "../uploads";

vi.mock("server-only", () => ({}));
const store = mkdtempSync(join(tmpdir(), "bl-store-"));
process.env.PREVIEW_STORE = "local";
process.env.PREVIEW_DIR = store;
const { acceptTalkThrough, acceptUpload } = await import("../upload-accept");

// A talk-through through the web app's own route core, functions and parsers, as the
// `authenticated` role with RLS. The worker's part (blob, transcript, draft) is written
// directly, as the table owner, the way the worker does.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const hana = "00000000-0000-4000-8000-0000000000a1";
const ivo = "00000000-0000-4000-8000-0000000000a2";
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
        rpcJson("record_talk_through($1, $2, $3, $4, $5::date, $6::timestamptz, $7::protocol_kind, $8, $9, $10)", [
          args.p_lab_id,
          args.p_sha256,
          args.p_size,
          args.p_name,
          args.p_uploaded_on,
          args.p_modified_at,
          args.p_kind,
          args.p_protocol_id,
          args.p_base_version_id,
          args.p_duration_ms,
        ]),
      );
      return { data, error: null };
    } catch (err) {
      return { data: null, error: z.object({ code: z.string().optional(), message: z.string() }).parse(err) };
    }
  };
}

const meta = (m: Partial<TalkThroughMeta> = {}): TalkThroughMeta => ({
  name: "Talk-through 2026-11-04 14.03.22.weba",
  uploadedOn: today,
  modifiedAt: null,
  durationMs: 95_000,
  target: { kind: "new", pageKind: "protocol" },
  ...m,
});

function request(bytes: Uint8Array<ArrayBuffer>, m: TalkThroughMeta, headers: Record<string, string> = {}) {
  return {
    headers: new Headers({
      "content-type": "audio/webm",
      "content-length": String(bytes.byteLength),
      ...talkThroughHeaders(m),
      ...headers,
    }),
    body: new Blob([bytes]).stream(),
  };
}

const view = (userId: string, id: string) => asUser(userId, async () => TalkThroughRows.parse(await rpcJson("talk_through($1)", [id])));

let labH: LabId;
let labI: LabId;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'hana@lab.edu'), ($2, 'ivo@lab.edu')", [hana, ivo]);
  labH = CreateLabResult.parse(await asUser(hana, async () => (await db.query("select create_lab('Hana Lab') as id")).rows[0]?.id));
  labI = CreateLabResult.parse(await asUser(ivo, async () => (await db.query("select create_lab('Ivo Lab') as id")).rows[0]?.id));
});

afterAll(async () => {
  await db.end();
});

describe("a talk-through from recording to a page", () => {
  const audio = new Uint8Array(4000).map((_, i) => (i * 17) % 253);
  const sha = createHash("sha256").update(audio).digest("hex");

  it("goes up through the upload route, is drafted, and its steps become a page", async () => {
    const first = await acceptTalkThrough(request(audio, meta()), labH, recordAs(hana));
    const again = await acceptTalkThrough(request(audio, meta()), labH, recordAs(hana));
    if (!("receipt" in first) || !("receipt" in again)) throw new Error(`expected receipts: ${JSON.stringify([first, again])}`);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.receipt).toEqual({ ...first.receipt, duplicate: true });
    expect(new Uint8Array(readFileSync(join(store, labH, "files", sha)))).toEqual(audio);
    const id = first.receipt.talkThroughId;

    const sent = await view(hana, id);
    expect(sent?.status).toEqual({ kind: "transcribing" });
    expect(sent?.audio.name).toBe("Talk-through 2026-11-04 14.03.22.weba");

    // The worker: the blob, the transcript, then the draft.
    await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 4000, 'audio/webm', 'audio')", [sha]);
    await db.query("update file_locations set sha256 = $1, index_state = 'indexed', indexed_at = now() where id = $2", [
      sha,
      first.receipt.locationId,
    ]);
    await db.query(
      "insert into extractions (sha256, extractor, extractor_version, kind, content) values ($1, 'fake', 1, 'transcript', 'Thaw the pellet on ice.')",
      [sha],
    );
    expect((await view(hana, id))?.status).toEqual({ kind: "drafting", transcript: "Thaw the pellet on ice." });
    await db.query(
      "update talk_throughs set draft = 'ready', draft_title = 'Lysis', draft_body = '## Steps\n\n1. Thaw the pellet on ice.\n', drafted_at = now() where id = $1",
      [id],
    );
    const ready = await view(hana, id);
    expect(ready?.status).toMatchObject({ kind: "ready", title: "Lysis" });

    const open = await asUser(hana, async () => OpenTalkThroughRows.parse(await rpcJson("open_talk_throughs($1, null)", [labH])));
    expect(open.map((t) => [t.id, t.progress])).toEqual([[id, "ready"]]);

    const saved = await asUser(hana, async () =>
      SavedVersionRows.parse(await rpcJson("use_talk_through($1, 'protocol', null, 'Lysis', $2, null)", [id, "1. Thaw the pellet on ice."])),
    );
    expect(saved.version).toBe(1);
    expect((await view(hana, id))?.used).toEqual({ protocolId: saved.protocolId, version: 1 });
    const linked = await asUser(hana, async () => (await db.query("select sha256 from protocol_files where protocol_id = $1", [saved.protocolId])).rows);
    expect(linked).toEqual([{ sha256: sha }]);
  });

  it("is invisible to another lab, and can't be recorded into one", async () => {
    const mine = await acceptTalkThrough(request(new Uint8Array(300).fill(9), meta()), labH, recordAs(hana));
    if (!("receipt" in mine)) throw new Error(JSON.stringify(mine));
    expect(await view(ivo, mine.receipt.talkThroughId)).toBeNull();
    await asUser(ivo, async () => {
      expect((await db.query("select 1 from talk_throughs where lab_id = $1", [labH])).rowCount).toBe(0);
      expect((await db.query("select 1 from file_locations where id = $1", [mine.receipt.locationId])).rowCount).toBe(0);
      expect(OpenTalkThroughRows.parse(await rpcJson("open_talk_throughs($1, null)", [labH]))).toEqual([]);
    });
    await expect(acceptTalkThrough(request(new Uint8Array(300).fill(8), meta()), labH, recordAs(ivo))).rejects.toThrow(/42501/);
    const theirs = await acceptTalkThrough(request(new Uint8Array(300).fill(7), meta()), labI, recordAs(ivo));
    expect(theirs.status).toBe(201);
  });

  it("has its own cap, takes sound only, and keeps audio out of the photo upload", async () => {
    const cap = await asUser(hana, async () => (await db.query("select audio_max_bytes() as n")).rows[0]?.n);
    expect(Number(cap)).toBe(AUDIO_MAX_BYTES);
    const bytes = new Uint8Array(100).fill(1);
    const big = await acceptTalkThrough(request(bytes, meta(), { "content-length": String(AUDIO_MAX_BYTES + 1) }), labH, recordAs(hana));
    const video = await acceptTalkThrough(request(bytes, meta(), { "content-type": "video/mp4" }), labH, recordAs(hana));
    const noPage = await acceptTalkThrough(
      request(bytes, meta(), { "x-talk-through-page": "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001" }),
      labH,
      recordAs(hana),
    );
    const asPhoto = await acceptUpload(
      {
        headers: new Headers({
          "content-type": "audio/webm",
          "content-length": "100",
          ...uploadHeaders({ name: "memo.weba", experiment: null, uploadedOn: today, modifiedAt: null }),
        }),
        body: new Blob([bytes]).stream(),
      },
      labH,
      async () => {
        throw new Error("a refused upload records nothing");
      },
    );
    expect([big.status, video.status, noPage.status, asPhoto.status]).toEqual([413, 415, 400, 415]);
  });

  it("mirrors the database's file kinds", async () => {
    const kinds = z
      .array(z.object({ v: z.string() }))
      .parse((await db.query("select unnest(enum_range(null::file_kind))::text as v")).rows)
      .map((r) => r.v);
    expect(kinds).toEqual(FileKind.options);
  });
});
