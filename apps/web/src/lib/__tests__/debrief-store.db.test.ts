import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { debriefAnswerHeaders, type Debrief, type DebriefQuestion } from "../debrief";
import { CreateLabResult } from "../domain";
import { LabId, RunId, Sha256, type DebriefId } from "../ids";
import type { RunDb } from "../run-record-store";
import { CompleteUploadRequest } from "../uploads";

// The debrief's route cores (lib/debrief-store.ts, and the upload complete route's debrief
// answer) against the real migrations, through a stand-in that calls each database function
// the way supabase-js does: by name, with named arguments, as the member under RLS.

vi.mock("server-only", () => ({}));
process.env.PREVIEW_STORE = "local";
process.env.PREVIEW_DIR = mkdtempSync(join(tmpdir(), "bl-debrief-store-"));
const { completeDebriefAnswer, receiveUploadBody, startUpload } = await import("../upload-accept");
const store = await import("../debrief-store");

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const fay = "00000000-0000-4000-8000-0000000db101";
const gus = "00000000-0000-4000-8000-0000000db102";
const today = new Date().toISOString().slice(0, 10);

function memberDb(userId: string): RunDb {
  return {
    rpc: async (fn, args) => {
      if (!/^[a-z_]+$/.test(fn) || !Object.keys(args).every((k) => /^[a-z_0-9]+$/.test(k))) throw new Error(`not a function call: ${fn}`);
      const call = `${fn}(${Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
        const res = await db.query(`select ${call} as v`, Object.values(args));
        await db.query("commit");
        return { data: z.object({ v: z.unknown() }).parse(res.rows[0]).v, error: null };
      } catch (err) {
        await db.query("rollback");
        const e = z.object({ code: z.string().optional(), message: z.string() }).parse(err);
        return { data: null, error: { code: e.code, message: e.message } };
      }
    },
  };
}

// What the browser does for one answer: start, PUT the bytes to the local store, complete.
async function sendAnswer(userId: string, labId: LabId, debriefId: DebriefId, question: DebriefQuestion, bytes: Uint8Array<ArrayBuffer>, type = "audio/webm") {
  const started = await startUpload(labId, { purpose: "run-debrief", size: bytes.byteLength, type });
  if (!("session" in started)) return started;
  const { uploadId, headers } = started.session;
  const put = await receiveUploadBody(labId, uploadId, { headers: new Headers({ ...headers, "content-length": String(bytes.byteLength) }), body: new Blob([bytes]).stream() });
  if (!("stored" in put)) return put;
  const meta = debriefAnswerHeaders({ debriefId, question, name: `Debrief question ${question}.weba`, uploadedOn: today });
  const claim = CompleteUploadRequest.parse({ size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  return completeDebriefAnswer(labId, uploadId, { headers: new Headers(meta), claim }, async (args) => await memberDb(userId).rpc("record_debrief_answer", args));
}
const ok = <T>(w: { kind: "ok"; value: T } | { kind: "error"; error: unknown }): T => {
  if (w.kind !== "ok") throw new Error(`expected ok: ${JSON.stringify(w.error)}`);
  return w.value;
};

let lab: LabId;
let otherLab: LabId;
let run: RunId;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'fay@debrief-store.test'), ($2, 'gus@debrief-store.test')", [fay, gus]);
  const made = async (userId: string, name: string) => LabId.parse(CreateLabResult.parse((await memberDb(userId).rpc("create_lab", { p_name: name })).data));
  lab = await made(fay, "Debrief store lab");
  otherLab = await made(gus, "Other debrief store lab");
  const source = (await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/d') returning id", [lab])).rows[0]?.id;
  const s = Sha256.parse(`db5${"0".repeat(60)}1`);
  await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 12, 'text/csv', 'spreadsheet')", [s]);
  await db.query(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, 'gel.csv', '/gel.csv', 'gel.csv', 12, now(), 'r', $3, 'indexed')`,
    [lab, source, s],
  );
  const created = await memberDb(fay).rpc("create_run", { p_lab_id: lab, p_shas: [s], p_fields: JSON.stringify({ title: "Gel", status: "failed" }) });
  run = RunId.parse(z.object({ id: z.string() }).parse(created.data).id);
});

afterAll(async () => {
  await db.end();
});

describe("the debrief through its route cores", () => {
  it("records, waits, reads the transcript, and saves the scientist's words to the run", async () => {
    const fayDb = memberDb(fay);
    expect(await store.loadRunDebrief(fayDb, run)).toBeNull();
    const started = ok(await store.startDebrief(fayDb, run));

    const bytes = new TextEncoder().encode("\x1aE\xdf\xa3 the words of answer three");
    const sent = await sendAnswer(fay, lab, started.id, 3, bytes);
    expect(sent.status).toBe(200);
    const receipt = "receipt" in sent ? sent.receipt : null;
    expect(receipt?.answers).toMatchObject([{ question: 3, words: { kind: "recording", heard: { kind: "transcribing" } } }]);

    // The worker: the blob, then the transcript.
    const sha = createHash("sha256").update(bytes).digest("hex");
    await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, $2, 'audio/webm', 'audio')", [sha, bytes.byteLength]);
    await db.query("update file_locations set sha256 = $1, index_state = 'indexed' where external_id = $1", [sha]);
    await db.query("insert into extractions (sha256, extractor, extractor_version, kind, content) values ($1, 'fake', 1, 'transcript', 'The agarose was old.')", [sha]);
    const heard: Debrief | null = await store.loadRunDebrief(fayDb, run);
    expect(heard?.answers).toMatchObject([{ question: 3, words: { heard: { kind: "heard", transcript: "The agarose was old." } } }]);

    ok(await store.saveAnswerText(fayDb, started.id, 1, "Run a 1% gel.", false));
    ok(await store.saveAnswerText(fayDb, started.id, 3, "The agarose stock was old.", true));
    ok(await store.setDebriefFix(fayDb, started.id, "yes"));
    const saved = ok(await store.approveDebrief(fayDb, started.id, true));
    expect(saved.debrief).toMatchObject({ aim: "Run a 1% gel.", fixWorked: "yes", expectedSeen: null });
    expect(saved.failure.suspectedCause).toBe("The agarose stock was old.");
    expect((await store.loadRunDebrief(fayDb, run))?.state).toBe("approved");
  });

  it("the upload refuses what isn't sound, a closed debrief, and another lab's", async () => {
    const fayDb = memberDb(fay);
    const d = ok(await store.startDebrief(fayDb, run));
    expect(await sendAnswer(fay, lab, d.id, 1, new TextEncoder().encode("not sound"), "text/plain")).toMatchObject({ status: 415 });
    expect(await sendAnswer(gus, otherLab, d.id, 1, new TextEncoder().encode("theirs"))).toMatchObject({ status: 403 });
    ok(await store.discardDebrief(fayDb, d.id));
    expect(await sendAnswer(fay, lab, d.id, 1, new TextEncoder().encode("late"))).toMatchObject({ status: 409, error: expect.stringContaining("already saved or thrown away") });
  });

  it("a database refusal reaches the browser in plain words", async () => {
    const d = ok(await store.startDebrief(memberDb(fay), run));
    const written = await store.approveDebrief(memberDb(fay), d.id, true);
    if (written.kind !== "error") throw new Error("expected a refusal");
    const res = store.debriefError(written.error, { event: "test", labId: lab });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "There's no answer to question 3 to use as the suspected cause." });
  });
});
