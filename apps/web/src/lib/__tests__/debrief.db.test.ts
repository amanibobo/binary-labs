import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DebriefJson, MaybeDebriefJson, type Debrief, type DebriefQuestion } from "../debrief";
import { CreateLabResult } from "../domain";
import { DebriefId, LabId, RunId, Sha256 } from "../ids";
import { RunJson } from "../run-record";

// The debrief's functions (0038) against the real migrations: as members of the lab, as a
// member of another lab, and as the worker, which writes a recording's transcript as an
// extraction.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ada = "00000000-0000-4000-8000-0000000db001";
const ben = "00000000-0000-4000-8000-0000000db002";
const cy = "00000000-0000-4000-8000-0000000db003";
const sha = (n: number) => Sha256.parse(`d${n.toString(16).padStart(63, "0")}`);
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
const one = z.object({ v: z.unknown() });
const call = (userId: string, sql: string, params: unknown[]) =>
  asUser(userId, async () => one.parse((await db.query(`select ${sql} as v`, params)).rows[0]).v);
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);
const owner = (sql: string, params: unknown[] = []) => db.query(sql, params);

let lab: LabId;
let otherLab: LabId;
let run: RunId;
let n = 0;

async function newRun(labId: LabId, userId: string, status: string | null): Promise<RunId> {
  n += 1;
  const s = sha(100 + n);
  const source = (await owner("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/' || $2) returning id", [labId, `r${n}`])).rows[0]?.id;
  await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/csv', 'spreadsheet')", [s]);
  await owner(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, $3, '/' || $3, $3, 10, now(), 'r', $4, 'indexed')`,
    [labId, source, `plate${n}.csv`, s],
  );
  const made = RunJson.parse(await call(userId, "create_run($1, $2, $3::jsonb)", [labId, [s], JSON.stringify({ title: `Run ${n}`, status })]));
  return made.id;
}

const start = (userId: string, runId: RunId) => call(userId, "start_debrief($1)", [runId]).then((d) => DebriefJson.parse(d));
const current = (userId: string, runId: RunId) => call(userId, "run_debrief($1)", [runId]).then((d) => MaybeDebriefJson.parse(d));
const typed = (userId: string, id: DebriefId, q: number, text: string) =>
  call(userId, "save_answer_text($1, $2::smallint, $3, false)", [id, q, text]).then((d) => DebriefJson.parse(d));
const correct = (userId: string, id: DebriefId, q: number, text: string) =>
  call(userId, "save_answer_text($1, $2::smallint, $3, true)", [id, q, text]).then((d) => DebriefJson.parse(d));
const fix = (userId: string, id: DebriefId, value: string | null) => call(userId, "set_debrief_fix($1, $2::run_fix)", [id, value]).then((d) => DebriefJson.parse(d));
const approve = (userId: string, id: DebriefId, useAsSuspected: boolean) =>
  call(userId, "approve_debrief($1, $2)", [id, useAsSuspected]).then((r) => RunJson.parse(r));

let clip = 0;
// A recording as the upload route records it: the bytes are in the store, the worker hasn't read them.
async function record(userId: string, id: DebriefId, q: number): Promise<{ debrief: Debrief; sha256: Sha256 }> {
  clip += 1;
  const s = sha(clip);
  const debrief = DebriefJson.parse(
    await call(userId, "record_debrief_answer($1, $2::smallint, $3, 4000, $4, $5::date, null)", [id, q, s, `Debrief answer ${clip}.weba`, today]),
  );
  return { debrief, sha256: s };
}
// The worker: the blob, then the transcript as an extraction, or a failure.
async function transcribe(s: Sha256, transcript: string) {
  await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, 4000, 'audio/webm', 'audio') on conflict do nothing", [s]);
  await owner("update file_locations set sha256 = $1, index_state = 'indexed', indexed_at = now() where external_id = $1", [s]);
  await owner("insert into extractions (sha256, extractor, extractor_version, kind, content) values ($1, 'fake', 1, 'transcript', $2)", [s, transcript]);
}
async function failTranscription(s: Sha256) {
  await owner("update file_locations set index_state = 'failed', index_error = 'no speech' where external_id = $1", [s]);
}
const wordsOf = (d: Debrief, q: DebriefQuestion) => d.answers.find((a) => a.question === q)?.words ?? { kind: "none" };

beforeAll(async () => {
  await db.connect();
  await owner("insert into auth.users (id, email) values ($1, 'ada@debrief.test'), ($2, 'ben@debrief.test'), ($3, 'cy@debrief.test')", [ada, ben, cy]);
  lab = LabId.parse(CreateLabResult.parse(await call(ada, "create_lab('Debrief lab')", [])));
  otherLab = LabId.parse(CreateLabResult.parse(await call(cy, "create_lab('Other debrief lab')", [])));
  await owner("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, ben]);
});

beforeEach(async () => {
  run = await newRun(lab, ada, "failed");
});

afterAll(async () => {
  await db.end();
});

describe("start_debrief", () => {
  it("opens one debrief per run, and a second start returns it", async () => {
    const first = await start(ada, run);
    expect(first).toMatchObject({ runId: run, state: "open", startedBy: ada, answers: [] });
    expect((await start(ben, run)).id).toBe(first.id);
    expect((await current(ben, run))?.id).toBe(first.id);
  });

  it("is only for a run that failed or was odd", async () => {
    expect(await codeOf(start(ada, await newRun(lab, ada, "worked")))).toBe("BL941");
    expect(await codeOf(start(ada, await newRun(lab, ada, null)))).toBe("BL941");
    expect((await start(ada, await newRun(lab, ada, "odd"))).state).toBe("open");
  });

  it("is refused to another lab, and the debrief reads as none to them", async () => {
    expect(await codeOf(start(cy, run))).toBe("42501");
    await start(ada, run);
    expect(await current(cy, run)).toBeNull();
  });
});

describe("answers", () => {
  it("a recording is transcribing until the worker writes its transcript, which the debrief reads", async () => {
    const d = await start(ada, run);
    const { debrief, sha256 } = await record(ada, d.id, 1);
    expect(wordsOf(debrief, 1)).toMatchObject({ kind: "recording", heard: { kind: "transcribing" }, correction: null });
    await transcribe(sha256, "Express BM3 in BL21 at 37 degrees.");
    const heard = await current(ada, run);
    expect(heard && wordsOf(heard, 1)).toMatchObject({ kind: "recording", heard: { kind: "heard", transcript: "Express BM3 in BL21 at 37 degrees." } });
  });

  it("a debrief recording is in the lab's Debriefs folder and can't be a run's file", async () => {
    const d = await start(ada, run);
    const { sha256 } = await record(ada, d.id, 1);
    await transcribe(sha256, "Hello.");
    const path = (await owner("select path from file_locations where external_id = $1", [sha256])).rows[0]?.path;
    expect(path).toBe(`/Uploads/Debriefs/Debrief answer ${clip}.weba`);
    expect(await codeOf(call(ada, "add_run_files($1, $2)", [run, [sha256]]))).toBe("BL904");
  });

  it("typing replaces a recording, recording replaces typing, and an empty typed answer clears it", async () => {
    const d = await start(ada, run);
    await record(ada, d.id, 2);
    expect(wordsOf(await typed(ada, d.id, 2, "  Bands at 50 kDa; saw none.  "), 2)).toEqual({ kind: "typed", text: "Bands at 50 kDa; saw none." });
    const again = await record(ada, d.id, 2);
    expect(wordsOf(again.debrief, 2)).toMatchObject({ kind: "recording", correction: null });
    expect(wordsOf(await typed(ada, d.id, 2, "   "), 2)).toEqual({ kind: "none" });
    expect((await current(ada, run))?.answers.map((a) => a.question)).toEqual([]);
  });

  it("a correction sits beside the transcript; the transcript again takes it back", async () => {
    const d = await start(ada, run);
    const { sha256 } = await record(ada, d.id, 3);
    expect(await codeOf(correct(ada, d.id, 3, "too early"))).toBe("BL944");
    await transcribe(sha256, "The IPTG was old.");
    expect(wordsOf(await correct(ada, d.id, 3, "The IPTG stock was old."), 3)).toMatchObject({
      heard: { kind: "heard", transcript: "The IPTG was old." },
      correction: "The IPTG stock was old.",
    });
    expect(wordsOf(await correct(ada, d.id, 3, " The IPTG was old. "), 3)).toMatchObject({ correction: null });
    expect(await codeOf(correct(ada, d.id, 4, "nothing recorded"))).toBe("22023");
  });

  it("question 5's tap is kept when its words change, and comes off on its own", async () => {
    const d = await start(ada, run);
    await fix(ada, d.id, "not_sure");
    await typed(ada, d.id, 5, "Used fresh IPTG.");
    await record(ada, d.id, 5);
    expect((await current(ada, run))?.answers).toMatchObject([{ question: 5, fixWorked: "not_sure", words: { kind: "recording" } }]);
    await fix(ada, d.id, null);
    expect((await current(ada, run))?.answers).toMatchObject([{ question: 5, fixWorked: null, words: { kind: "recording" } }]);
    await fix(ada, d.id, "yes");
    await typed(ada, d.id, 5, "");
    expect((await current(ada, run))?.answers).toEqual([{ question: 5, fixWorked: "yes", words: { kind: "none" } }]);
    await fix(ada, d.id, null);
    expect((await current(ada, run))?.answers).toEqual([]);
  });

  it("a question is 1 to 6", async () => {
    const d = await start(ada, run);
    expect(await codeOf(typed(ada, d.id, 7, "x"))).toBe("22023");
    expect(await codeOf(record(ada, d.id, 0))).toBe("22023");
  });

  it("another lab can't answer, and nobody can answer a debrief that's closed", async () => {
    const d = await start(ada, run);
    expect(await codeOf(typed(cy, d.id, 1, "x"))).toBe("42501");
    expect(await codeOf(record(cy, d.id, 1))).toBe("42501");
    expect(await codeOf(fix(cy, d.id, "yes"))).toBe("42501");
    expect(await codeOf(call(cy, "discard_debrief($1)", [d.id]))).toBe("42501");
    await call(ada, "discard_debrief($1)", [d.id]);
    expect(await codeOf(typed(ada, d.id, 1, "x"))).toBe("BL943");
    expect(await codeOf(call(ada, "discard_debrief($1)", [d.id]))).toBe("BL943");
    expect(await codeOf(typed(ada, DebriefId.parse("00000000-0000-4000-8000-00000000dead"), 1, "x"))).toBe("BL942");
    // A thrown-away debrief isn't the run's; a new start opens another.
    expect(await current(ada, run)).toBeNull();
    expect((await start(ada, run)).id).not.toBe(d.id);
  });
});

describe("approve_debrief", () => {
  it("copies each answer as it stands, saves the unanswered empty, and writes no cause unless ticked", async () => {
    const d = await start(ada, run);
    await typed(ada, d.id, 1, "Express BM3.");
    const two = await record(ada, d.id, 2);
    const three = await record(ada, d.id, 3);
    await fix(ada, d.id, "no");
    await transcribe(two.sha256, "Expected a band at 118 kDa, saw nothing.");
    await transcribe(three.sha256, "I think the IPTG was old.");
    await correct(ada, d.id, 2, "Expected a band at 118 kDa; saw nothing on the gel.");
    const saved = await approve(ben, d.id, false);
    expect(saved.debrief).toMatchObject({
      aim: "Express BM3.",
      expectedSeen: "Expected a band at 118 kDa; saw nothing on the gel.",
      howFound: null,
      whatChanged: null,
      fixWorked: "no",
      whoElse: null,
    });
    expect(saved.debrief.debriefedAt).not.toBeNull();
    expect(saved.failure).toMatchObject({ suspectedCause: null, suspectedBy: null, confirmedCause: null, confirmedBy: null });
    expect((await current(ada, run))?.state).toBe("approved");
    expect(await codeOf(approve(ada, d.id, false))).toBe("BL943");
  });

  it("question 3 becomes the suspected cause only on the tap, in the scientist's words, and the confirmed cause is never written", async () => {
    const d = await start(ada, run);
    const three = await record(ada, d.id, 3);
    await transcribe(three.sha256, "I think the IPTG was old.");
    const saved = await approve(ben, d.id, true);
    expect(saved.failure).toMatchObject({ suspectedCause: "I think the IPTG was old.", suspectedBy: ben, confirmedCause: null, confirmedAt: null });
    const log = await owner("select after from run_log where run_id = $1 and action = 'run.edit' order by id desc limit 1", [run]);
    expect(log.rows[0]?.after).toMatchObject({ suspected_cause: "I think the IPTG was old." });
  });

  it("an untouched suspected cause stays when the tap is off", async () => {
    await owner("update runs set suspected_cause = 'Written before the debrief.' where id = $1", [run]);
    const d = await start(ada, run);
    await typed(ada, d.id, 3, "Maybe the cells.");
    expect((await approve(ada, d.id, false)).failure.suspectedCause).toBe("Written before the debrief.");
  });

  it("a second debrief replaces the first one's answers, missing ones included", async () => {
    const first = await start(ada, run);
    await typed(ada, first.id, 1, "First aim.");
    await typed(ada, first.id, 6, "Priya saw it.");
    await approve(ada, first.id, false);
    const second = await start(ada, run);
    await typed(ada, second.id, 1, "Second aim.");
    expect((await approve(ada, second.id, false)).debrief).toMatchObject({ aim: "Second aim.", whoElse: null });
  });

  it("waits for transcripts, refuses a recording nobody could make out, and needs words for the tap", async () => {
    const d = await start(ada, run);
    const one = await record(ada, d.id, 1);
    expect(await codeOf(approve(ada, d.id, false))).toBe("BL944");
    await failTranscription(one.sha256);
    expect(await codeOf(approve(ada, d.id, false))).toBe("BL945");
    await typed(ada, d.id, 1, "Typed instead.");
    expect(await codeOf(approve(ada, d.id, true))).toBe("BL946");
    expect((await approve(ada, d.id, false)).debrief.aim).toBe("Typed instead.");
  });

  it("is refused once the run no longer failed or was odd, and to another lab", async () => {
    const d = await start(ada, run);
    await typed(ada, d.id, 1, "Aim.");
    expect(await codeOf(approve(cy, d.id, false))).toBe("42501");
    await call(ada, "set_run_status($1, 'worked', false)", [run]);
    expect(await codeOf(approve(ada, d.id, false))).toBe("BL941");
  });

  it("a shared run stops being shared when its debrief is saved", async () => {
    await owner("update runs set share = true where id = $1", [run]);
    const d = await start(ada, run);
    await typed(ada, d.id, 1, "Aim.");
    expect((await approve(ada, d.id, false)).share).toBe(false);
  });
});

describe("grants", () => {
  it("members can't call the helpers or read another debrief directly", async () => {
    const d = await start(ada, run);
    for (const sql of ["member_debrief($1)", "debrief_json($1)"]) expect(await codeOf(call(ada, sql, [d.id]))).toBe("42501");
    expect(await codeOf(call(ada, "debrief_transcript($1)", [d.id]))).toBe("42501");
  });

  it("the debrief reads as none to another lab", async () => {
    const d = await start(ada, run);
    expect(await current(cy, run)).toBeNull();
    const theirs = await newRun(otherLab, cy, "failed");
    expect(await current(ada, theirs)).toBeNull();
    expect(d.state).toBe("open");
  });
});
