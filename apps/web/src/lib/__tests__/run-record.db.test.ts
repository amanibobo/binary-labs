import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { ExperimentId, LabId, PersonId, RunId, Sha256 } from "../ids";
import { fieldArgs, FileRunsJson, RunJson, RunRefsJson, RunRowsJson, RunSuggestionsJson, type NewRunFields, type RunRecord } from "../run-record";

// The run record's tables, triggers and functions against the real migrations: as members of
// the lab, as a member of another lab, as someone in no lab, signed out, and as the worker
// (the owner, which skips row security).

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ada = "00000000-0000-4000-8000-0000000f0001";
const ben = "00000000-0000-4000-8000-0000000f0002";
const cy = "00000000-0000-4000-8000-0000000f0003";
const dee = "00000000-0000-4000-8000-0000000f0004";
const sha = (n: number) => Sha256.parse(`f${n.toString(16).padStart(63, "0")}`);

async function asRole<T>(role: "authenticated" | "anon", userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claims', $1, true)", [userId === null ? "" : JSON.stringify({ sub: userId })]);
    const out = await fn();
    await db.query("commit");
    return out;
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
}
const asUser = <T>(userId: string, fn: () => Promise<T>) => asRole("authenticated", userId, fn);

const one = z.object({ v: z.unknown() });
const call = (userId: string, sql: string, params: unknown[]) =>
  asUser(userId, async () => one.parse((await db.query(`select ${sql} as v`, params)).rows[0]).v);
const rows = (userId: string, sql: string, params: unknown[]) =>
  asUser(userId, async () => one.parse((await db.query(`select coalesce(jsonb_agg(r), '[]') as v from ${sql} r`, params)).rows[0]).v);
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);
// The worker's connection: the owner, with no signed-in user.
const owner = (sql: string, params: unknown[] = []) => db.query(sql, params);
const count = async (sql: string, params: unknown[] = []) => Number((await owner(`select count(*) as n from ${sql}`, params)).rows[0]?.n);

let lab: LabId;
let otherLab: LabId;
let hela: ExperimentId;
let theirs: ExperimentId;
let priya: PersonId;
let source: string;
let otherSource: string;

async function addFile(labId: LabId, sourceId: string, s: Sha256, name: string) {
  await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/csv', 'spreadsheet') on conflict do nothing", [s]);
  const res = await owner(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, $3, '/' || $3, $3, 10, now(), 'r', $4, 'indexed') returning id`,
    [labId, sourceId, name, s],
  );
  return z.string().parse(res.rows[0]?.id);
}

type Seed = { name: string; status?: string; outcome?: string | null; experiment?: string | null; date?: string | null; person?: string | null };
async function addLabel(labId: LabId, s: Sha256, seed: Seed) {
  await owner(
    `insert into labels (lab_id, sha256, status, clean_name, experiment_id, person_id, date, confidence, source, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, 0.8, 'model', $8)`,
    [labId, s, seed.status ?? "check", seed.name, seed.experiment ?? null, seed.person ?? null, seed.date ?? null, seed.outcome ?? null],
  );
}

const create = (userId: string, labId: LabId, shas: Sha256[], fields: NewRunFields = {}) =>
  call(userId, "create_run($1, $2, $3::jsonb)", [labId, shas, JSON.stringify(fieldArgs(fields))]).then((r) => RunJson.parse(r));
const read = async (userId: string, id: RunId): Promise<RunRecord | null> => {
  const json = await call(userId, "run_json($1)", [id]);
  return json === null ? null : RunJson.parse(json);
};
const setStatus = (userId: string, id: RunId, status: string | null, clear = false) =>
  call(userId, "set_run_status($1, $2, $3)", [id, status, clear]).then((r) => RunJson.parse(r));
const logOf = async (id: RunId) =>
  z
    .array(z.object({ action: z.string(), via: z.string(), actor: z.string().nullable(), before: z.unknown(), after: z.unknown() }))
    .parse((await owner("select action, via, actor, before, after from run_log where run_id = $1 order by id", [id])).rows);

beforeAll(async () => {
  await db.connect();
  await owner("insert into auth.users (id, email) values ($1, 'ada@runs.test'), ($2, 'ben@runs.test'), ($3, 'cy@runs.test'), ($4, 'dee@runs.test')", [ada, ben, cy, dee]);
  lab = LabId.parse(CreateLabResult.parse(await call(ada, "create_lab('Runs lab')", [])));
  otherLab = LabId.parse(CreateLabResult.parse(await call(cy, "create_lab('Other runs lab')", [])));
  await owner("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, ben]);
  hela = ExperimentId.parse((await owner("insert into experiments (lab_id, name) values ($1, 'HeLa drug A') returning id", [lab])).rows[0]?.id);
  theirs = ExperimentId.parse((await owner("insert into experiments (lab_id, name) values ($1, 'Secret') returning id", [otherLab])).rows[0]?.id);
  priya = PersonId.parse((await owner("insert into people (lab_id, display_name) values ($1, 'Priya') returning id", [lab])).rows[0]?.id);
  await owner("insert into people (lab_id, display_name, member_user_id) values ($1, 'Ben', $2)", [lab, ben]);
  source = (await owner("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/r') returning id", [lab])).rows[0]?.id;
  otherSource = (await owner("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/o') returning id", [otherLab])).rows[0]?.id;
  for (let n = 1; n <= 12; n += 1) await addFile(lab, source, sha(n), `plate${n}.csv`);
  await addFile(otherLab, otherSource, sha(50), "theirs.csv");
  await addLabel(lab, sha(1), { name: "Drug A plate 1", outcome: "failed", experiment: hela, date: "2026-11-02", person: priya, status: "accepted" });
  await addLabel(lab, sha(2), { name: "Drug A gel", outcome: "worked" });
  await addLabel(lab, sha(3), { name: "Drug A plate 2", outcome: "unclear", status: "corrected" });
  await addLabel(lab, sha(4), { name: "Drug A plate 3", outcome: "worked", status: "accepted", date: "2026-11-09" });
  await addLabel(otherLab, sha(50), { name: "Their run", outcome: "failed", status: "accepted" });
});

afterAll(async () => {
  await db.end();
});

describe("create_run", () => {
  it("makes a run from the picked files, named, dated and first marked from the first file's label", async () => {
    const run = await create(ada, lab, [sha(1), sha(2), sha(1)]);
    expect(run).toMatchObject({
      title: "Drug A plate 1",
      startedOn: "2026-11-02",
      experiment: { id: hela, name: "HeLa drug A" },
      person: { id: priya, name: "Priya" },
      status: "failed",
      statusBy: null,
      createdBy: ada,
      share: false,
      retryOf: null,
    });
    expect(run.files.map((f) => ({ sha: f.sha256, role: f.role, name: f.name, says: f.fileSays, live: f.locationId !== null }))).toEqual([
      { sha: sha(1), role: "evidence", name: "Drug A plate 1", says: "failed", live: true },
      { sha: sha(2), role: "evidence", name: "Drug A gel", says: "worked", live: true },
    ]);
    expect(run.failure.suspectedCause).toBeNull();
    expect(await logOf(run.id)).toMatchObject([{ action: "run.create", via: "person", actor: ada }, { action: "run.files" }, { action: "run.files" }]);
  });

  it("leaves the status empty when the label says unclear or nothing, and uses the caller as the person", async () => {
    const unclear = await create(ben, lab, [sha(3)]);
    expect(unclear).toMatchObject({ status: null, statusAt: null, person: { name: "Ben" } });
    const unlabeled = await create(ada, lab, [sha(5)]);
    expect(unlabeled).toMatchObject({ title: "plate5.csv", status: null, person: null, startedOn: null });
  });

  it("takes the fields it is given over the label's, and a status a person gives is theirs", async () => {
    const run = await create(ben, lab, [sha(1)], { title: "  Tuesday's attempt ", startedOn: "2026-11-03", endedOn: "2026-11-04", experimentId: null, personId: null, status: "odd" });
    expect(run).toMatchObject({ title: "Tuesday's attempt", startedOn: "2026-11-03", endedOn: "2026-11-04", experiment: null, person: null, status: "odd", statusBy: ben });
  });

  it("lets one file be evidence of two runs", async () => {
    const a = await create(ada, lab, [sha(6)]);
    const b = await create(ada, lab, [sha(6), sha(7)]);
    expect(a.id).not.toBe(b.id);
    expect(await count("run_files where lab_id = $1 and sha256 = $2", [lab, sha(6)])).toBe(2);
  });

  it("refuses another lab's member, someone in no lab, and a signed-out caller", async () => {
    expect(await codeOf(create(cy, lab, [sha(1)]))).toBe("42501");
    expect(await codeOf(create(dee, lab, [sha(1)]))).toBe("42501");
    expect(await codeOf(asRole("anon", null, () => db.query("select create_run($1, $2, '{}')", [lab, [sha(1)]])))).toBe("42501");
  });

  it("refuses a file of another lab, a deleted file, a recording, no files and too many", async () => {
    expect(await codeOf(create(ada, lab, [sha(50)]))).toBe("BL901");
    expect(await codeOf(create(ada, lab, [sha(1), sha(50)]))).toBe("BL901");
    const gone = await addFile(lab, source, sha(20), "gone.csv");
    await owner("update file_locations set deleted_at = now() where id = $1", [gone]);
    expect(await codeOf(create(ada, lab, [sha(20)], { title: "Gone" }))).toBe("BL901");
    const recording = await addFile(lab, source, sha(21), "talk.webm");
    await owner("insert into talk_throughs (lab_id, location_id, kind) values ($1, $2, 'protocol')", [lab, recording]);
    expect(await codeOf(create(ada, lab, [sha(1), sha(21)]))).toBe("BL904");
    expect(await codeOf(create(ada, lab, []))).toBe("BL908");
    expect(await codeOf(create(ada, lab, Array.from({ length: 51 }, (_, i) => sha(i + 100))))).toBe("BL908");
  });

  it("refuses an experiment, a person or an earlier run from another lab", async () => {
    const their = await create(cy, otherLab, [sha(50)]);
    expect(await codeOf(create(ada, lab, [sha(1)], { experimentId: theirs }))).toBe("BL905");
    expect(await codeOf(create(ada, lab, [sha(1)], { retryOf: their.id }))).toBe("BL907");
    const before = await count("runs where lab_id = $1", [lab]);
    expect(await codeOf(create(ada, lab, [sha(1), sha(50)]))).toBe("BL901");
    expect(await count("runs where lab_id = $1", [lab])).toBe(before);
  });
});

describe("the run's status is the only truth about a run", () => {
  it("is not changed by a label, and changes no label", async () => {
    const run = await create(ada, lab, [sha(4)]);
    expect(run.status).toBe("worked");
    const runs = await count("runs");
    await call(ada, "correct_labels($1, $2, $3::jsonb)", [lab, [sha(4)], JSON.stringify({ field: "outcome", value: "failed" })]);
    // The worker relabeling the file is a plain update.
    await owner("update labels set outcome = 'unclear' where lab_id = $1 and sha256 = $2", [lab, sha(4)]);
    expect((await read(ada, run.id))?.status).toBe("worked");
    expect(await count("runs")).toBe(runs);

    await setStatus(ada, run.id, "failed");
    const label = z.object({ outcome: z.string() }).parse((await owner("select outcome from labels where lab_id = $1 and sha256 = $2", [lab, sha(4)])).rows[0]);
    expect(label.outcome).toBe("unclear");
    expect((await read(ada, run.id))?.files[0]?.fileSays).toBe("unclear");
    await owner("update labels set outcome = 'worked', status = 'accepted' where lab_id = $1 and sha256 = $2", [lab, sha(4)]);
  });

  it("makes no run when a label gains an outcome or a file gets a new version", async () => {
    const runs = await count("runs");
    await addLabel(lab, sha(8), { name: "Plate 8", outcome: "failed", status: "accepted" });
    await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/csv', 'spreadsheet')", [sha(30)]);
    await owner("update file_locations set sha256 = $2 where lab_id = $1 and sha256 = $3", [lab, sha(30), sha(8)]);
    expect(await count("runs")).toBe(runs);
    await owner("update file_locations set sha256 = $2 where lab_id = $1 and sha256 = $3", [lab, sha(8), sha(30)]);
  });

  it("still finds a run's file in the lab's folder after it's edited there", async () => {
    const run = await create(ada, lab, [sha(8)]);
    const before = (await read(ada, run.id))?.files[0]?.locationId;
    expect(before).not.toBeNull();
    await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/csv', 'spreadsheet') on conflict do nothing", [sha(31)]);
    await owner("update file_locations set sha256 = $2 where lab_id = $1 and sha256 = $3", [lab, sha(31), sha(8)]);
    expect((await read(ada, run.id))?.files[0]?.locationId).toBe(before);
    await owner("update file_locations set sha256 = $2 where lab_id = $1 and sha256 = $3", [lab, sha(8), sha(31)]);
  });
});

describe("set_run_status", () => {
  it("lets any member of the lab say how it went, and take the answer back", async () => {
    const run = await create(ada, lab, [sha(5)]);
    const odd = await setStatus(ben, run.id, "odd");
    expect(odd).toMatchObject({ status: "odd", statusBy: ben });
    expect(odd.statusAt).not.toBeNull();
    expect(await setStatus(ada, run.id, null)).toMatchObject({ status: null, statusAt: null });
    const log = await logOf(run.id);
    const status = (side: unknown) => z.object({ status: z.string().nullable() }).parse(side).status;
    expect(log.filter((l) => l.action === "run.edit").map((l) => [l.actor, status(l.before), status(l.after)])).toEqual([
      [ben, null, "odd"],
      [ada, "odd", null],
    ]);
  });

  it("refuses another lab's member, someone in no lab, a signed-out caller and a run that isn't there", async () => {
    const run = await create(ada, lab, [sha(5)]);
    expect(await codeOf(setStatus(cy, run.id, "worked"))).toBe("42501");
    expect(await codeOf(setStatus(dee, run.id, "worked"))).toBe("42501");
    expect(await codeOf(asRole("anon", null, () => db.query("select set_run_status($1, 'worked')", [run.id])))).toBe("42501");
    expect(await codeOf(setStatus(ada, RunId.parse("00000000-0000-4000-8000-000000000999"), "worked"))).toBe("BL907");
    expect((await read(ada, run.id))?.status).toBeNull();
  });

  it("only leaves failed or odd with a cause written down when told to clear it, and the log keeps the cause", async () => {
    const run = await create(ada, lab, [sha(1)]);
    await owner(
      `update runs set suspected_cause = 'old antibody', confirmed_cause = 'antibody lot 12 was dead', confirmed_by = $2,
        confirm_method = 'control', confirmed_at = now(), taxonomy_version = 1, cause_category = 'cause.reagent' where id = $1`,
      [run.id, priya],
    );
    expect(await codeOf(setStatus(ada, run.id, "worked"))).toBe("BL906");
    expect(await codeOf(setStatus(ada, run.id, null))).toBe("BL906");
    // Failed to odd keeps the cause.
    expect((await setStatus(ada, run.id, "odd")).failure.confirmedCause).toBe("antibody lot 12 was dead");

    const cleared = await setStatus(ben, run.id, "worked", true);
    expect(cleared.status).toBe("worked");
    expect(cleared.failure).toMatchObject({ suspectedCause: null, confirmedCause: null, confirmedBy: null, confirmMethod: null, confirmedAt: null, taxonomyVersion: null, causeCategory: null });
    const last = (await logOf(run.id)).at(-1);
    expect(last).toMatchObject({ action: "run.edit", actor: ben, before: { confirmed_cause: "antibody lot 12 was dead", suspected_cause: "old antibody", status: "odd" } });
  });
});

describe("the cause checks", () => {
  it("has no null hole: a cause can't sit on a run nobody has marked, or on one that worked", async () => {
    const run = await create(ada, lab, [sha(5)]);
    expect(await codeOf(owner("update runs set suspected_cause = 'x' where id = $1", [run.id]))).toBe("23514");
    expect(await codeOf(owner("insert into runs (lab_id, title, suspected_cause) values ($1, 'Hole', 'x')", [lab]))).toBe("23514");
    await owner("update runs set status = 'failed', status_at = now(), suspected_cause = 'x' where id = $1", [run.id]);
    expect(await codeOf(owner("update runs set status = null, status_at = null where id = $1", [run.id]))).toBe("23514");
    expect(await codeOf(owner("update runs set status = 'worked' where id = $1", [run.id]))).toBe("23514");
  });

  it("needs a named confirmer, a method and a time for a confirmed cause, from this lab", async () => {
    const run = await create(ada, lab, [sha(1)]);
    expect(await codeOf(owner("update runs set confirmed_cause = 'x' where id = $1", [run.id]))).toBe("23514");
    expect(await codeOf(owner("update runs set confirmed_cause = 'x', confirmed_by = $2, confirm_method = 'repeat' where id = $1", [run.id, priya]))).toBe("23514");
    const stranger = (await owner("insert into people (lab_id, display_name) values ($1, 'Stranger') returning id", [otherLab])).rows[0]?.id;
    expect(await codeOf(owner("update runs set confirmed_cause = 'x', confirmed_by = $2, confirm_method = 'repeat', confirmed_at = now() where id = $1", [run.id, stranger]))).toBe("23503");
    expect(await codeOf(owner("update runs set taxonomy_version = 1, technique = 'tech.nope' where id = $1", [run.id]))).toBe("23503");
    expect(await codeOf(owner("update runs set taxonomy_version = 1, technique = 'cause.reagent' where id = $1", [run.id]))).toBe("23514");
  });
});

describe("add_run_files and remove_run_file", () => {
  it("adds files in order, changes a role, and takes a file out without touching the file", async () => {
    const run = await create(ada, lab, [sha(1)]);
    const added = RunJson.parse(await call(ben, "add_run_files($1, $2, 'shared_control')", [run.id, [sha(9), sha(2)]]));
    expect(added.files.map((f) => [f.sha256, f.role])).toEqual([
      [sha(1), "evidence"],
      [sha(9), "shared_control"],
      [sha(2), "shared_control"],
    ]);
    const again = RunJson.parse(await call(ada, "add_run_files($1, $2, 'standard')", [run.id, [sha(9)]]));
    expect(again.files.map((f) => f.role)).toEqual(["evidence", "standard", "shared_control"]);
    const removed = RunJson.parse(await call(ada, "remove_run_file($1, $2)", [run.id, sha(9)]));
    expect(removed.files.map((f) => f.sha256)).toEqual([sha(1), sha(2)]);
    expect(await count("file_locations where lab_id = $1 and sha256 = $2 and deleted_at is null", [lab, sha(9)])).toBe(1);
    expect((await logOf(run.id)).filter((l) => l.action === "run.files").length).toBe(5);
  });

  it("keeps one file in a run", async () => {
    const run = await create(ada, lab, [sha(1)]);
    expect(await codeOf(call(ada, "remove_run_file($1, $2)", [run.id, sha(1)]))).toBe("BL902");
    expect((await read(ada, run.id))?.files.length).toBe(1);
  });

  it("refuses another lab's member and another lab's file, and members can't write the tables", async () => {
    const run = await create(ada, lab, [sha(1)]);
    expect(await codeOf(call(cy, "add_run_files($1, $2)", [run.id, [sha(50)]]))).toBe("42501");
    expect(await codeOf(call(dee, "remove_run_file($1, $2)", [run.id, sha(1)]))).toBe("42501");
    expect(await codeOf(call(ada, "add_run_files($1, $2)", [run.id, [sha(50)]]))).toBe("BL901");
    expect(await codeOf(asUser(ada, () => db.query("insert into run_files (run_id, lab_id, sha256, position) values ($1, $2, $3, 9)", [run.id, lab, sha(2)])))).toBe("42501");
    expect(await codeOf(asUser(ada, () => db.query("update runs set status = 'worked', status_at = now() where id = $1", [run.id])))).toBe("42501");
    expect(await codeOf(asUser(ada, () => db.query("delete from run_log where run_id = $1", [run.id])))).toBe("42501");
    expect(await codeOf(asUser(ada, () => db.query("select put_run_files($1, $2, $3, 'evidence')", [run.id, lab, [sha(2)]])))).toBe("42501");
  });

  it("refuses content the lab never read even from the worker", async () => {
    const run = await create(ada, lab, [sha(1)]);
    expect(await codeOf(owner("insert into run_files (run_id, lab_id, sha256, position) values ($1, $2, $3, 9)", [run.id, lab, sha(50)]))).toBe("BL901");
  });
});

describe("link_retry", () => {
  it("shows the link on both runs, and takes it away", async () => {
    const first = await create(ada, lab, [sha(1)]);
    const second = await create(ada, lab, [sha(2)]);
    const linked = RunJson.parse(await call(ben, "link_retry($1, $2)", [second.id, first.id]));
    expect(linked.retryOf).toMatchObject({ id: first.id, title: "Drug A plate 1", status: "failed" });
    expect((await read(ada, first.id))?.retriedIn.map((r) => r.id)).toEqual([second.id]);
    expect(RunJson.parse(await call(ada, "link_retry($1, null)", [second.id])).retryOf).toBeNull();
    expect((await read(ada, first.id))?.retriedIn).toEqual([]);
  });

  it("refuses a loop, itself, another lab's run and another lab's member", async () => {
    const a = await create(ada, lab, [sha(1)]);
    const b = await create(ada, lab, [sha(2)], { retryOf: a.id });
    const c = await create(ada, lab, [sha(3)], { retryOf: b.id });
    const their = await create(cy, otherLab, [sha(50)]);
    expect(await codeOf(call(ada, "link_retry($1, $2)", [a.id, c.id]))).toBe("BL903");
    expect(await codeOf(call(ada, "link_retry($1, $2)", [a.id, a.id]))).toBe("BL903");
    expect(await codeOf(call(ada, "link_retry($1, $2)", [a.id, their.id]))).toBe("BL907");
    expect(await codeOf(call(cy, "link_retry($1, $2)", [c.id, a.id]))).toBe("42501");
    expect(await codeOf(call(dee, "link_retry($1, null)", [c.id]))).toBe("42501");
    expect((await read(ada, a.id))?.retryOf).toBeNull();

    const offered = RunRefsJson.parse(await rows(ada, "retry_candidates($1, 'drug', 20)", [a.id]));
    expect(offered.map((r) => r.id)).not.toContain(a.id);
    expect(offered.map((r) => r.id)).not.toContain(b.id);
    expect(offered.map((r) => r.id)).not.toContain(c.id);
    expect(offered.map((r) => r.id)).not.toContain(their.id);
    expect(offered.length).toBeGreaterThan(0);
    expect(RunRefsJson.parse(await rows(cy, "retry_candidates($1, '', 20)", [a.id]))).toEqual([]);
  });

  it("offers the run a file's repeat link points at, and leaves the repeat link alone", async () => {
    await addLabel(lab, sha(10), { name: "Repeat of plate 5", outcome: "worked" });
    await addLabel(lab, sha(11), { name: "First plate", outcome: "failed" });
    await call(ada, "link_repeat($1, $2, $3)", [lab, sha(10), sha(11)]);
    const earlier = await create(ada, lab, [sha(11)]);
    const later = await create(ada, lab, [sha(10)]);
    expect(later.retryOf).toBeNull();
    expect(later.retryHint).toMatchObject({ id: earlier.id });
    await call(ada, "link_retry($1, $2)", [later.id, earlier.id]);
    expect((await read(ada, later.id))?.retryHint).toBeNull();
    expect(await count("run_repeats where lab_id = $1 and sha256 = $2", [lab, sha(10)])).toBe(1);
  });
});

describe("reading runs", () => {
  it("shows a run to its lab only", async () => {
    const run = await create(ada, lab, [sha(1)]);
    expect((await read(ben, run.id))?.id).toBe(run.id);
    expect(await read(cy, run.id)).toBeNull();
    expect(await read(dee, run.id)).toBeNull();
    expect(await codeOf(asRole("anon", null, () => db.query("select run_json($1)", [run.id])))).toBe("42501");
    expect((await asUser(cy, () => db.query("select id from runs where lab_id = $1", [lab]))).rows).toEqual([]);
    expect((await asUser(cy, () => db.query("select run_id from run_files where lab_id = $1", [lab]))).rows).toEqual([]);
    expect((await asUser(cy, () => db.query("select id from run_log where lab_id = $1", [lab]))).rows).toEqual([]);
  });

  it("names the newest run a file is evidence of, never one it is only a control for", async () => {
    await addFile(lab, source, sha(40), "plate40.csv");
    await addFile(lab, source, sha(41), "control41.csv");
    const old = await create(ada, lab, [sha(40)], { startedOn: "2026-10-01", status: "failed" });
    const recent = await create(ada, lab, [sha(40)], { startedOn: "2026-11-01", status: "worked" });
    await call(ada, "add_run_files($1, $2, 'shared_control')", [recent.id, [sha(41)]]);
    const found = FileRunsJson.parse(await rows(ada, "file_runs($1, $2)", [lab, [sha(40), sha(41), sha(12)]]));
    expect(found).toEqual([{ sha256: sha(40), runId: recent.id, title: "plate40.csv", status: "worked" }]);
    expect(old.id).not.toBe(recent.id);
    expect(FileRunsJson.parse(await rows(cy, "file_runs($1, $2)", [lab, [sha(40)]]))).toEqual([]);
  });

  it("lists the lab's runs newest first and filters by status", async () => {
    const all = RunRowsJson.parse(await rows(ada, "lab_runs($1, '{}', 200, 0)", [lab]));
    expect(all.length).toBe(await count("runs where lab_id = $1", [lab]));
    const days = all.map((r) => r.startedOn).filter((d): d is string => d !== null);
    expect(days).toEqual([...days].sort().reverse());
    const failed = RunRowsJson.parse(await rows(ada, `lab_runs($1, '{"status":"failed"}', 200, 0)`, [lab]));
    expect(failed.length).toBeGreaterThan(0);
    expect(new Set(failed.map((r) => r.status))).toEqual(new Set(["failed"]));
    const unmarked = RunRowsJson.parse(await rows(ada, `lab_runs($1, '{"status":"none"}', 200, 0)`, [lab]));
    expect(new Set(unmarked.map((r) => r.status))).toEqual(new Set([null]));
    expect(RunRowsJson.parse(await rows(cy, "lab_runs($1, '{}', 200, 0)", [lab]))).toEqual([]);
  });

  it("still hands over a run's file after it is gone from the lab's folder", async () => {
    const place = await addFile(lab, source, sha(42), "gel42.tif");
    const run = await create(ada, lab, [sha(42)]);
    await owner("update file_versions set kept_at = now() where lab_id = $1 and sha256 = $2", [lab, sha(42)]);
    await owner("update file_locations set deleted_at = now() where id = $1", [place]);
    const after = await read(ada, run.id);
    expect(after?.files[0]).toMatchObject({ sha256: sha(42), locationId: null, kept: true, originalName: "gel42.tif" });
    const file = await rows(ben, "run_file($1, $2)", [run.id, sha(42)]);
    expect(file).toEqual([{ lab_id: lab, sha256: sha(42), original_name: "gel42.tif", mime: "text/csv", kept: true }]);
    expect(await rows(cy, "run_file($1, $2)", [run.id, sha(42)])).toEqual([]);
    expect(await rows(ada, "run_file($1, $2)", [run.id, sha(1)])).toEqual([]);
  });
});

describe("run_suggestions", () => {
  it("offers files a person vouched for that say how they went, until the member puts the list away", async () => {
    await addFile(lab, source, sha(60), "s60.csv");
    await addFile(lab, source, sha(61), "s61.csv");
    await addFile(lab, source, sha(62), "s62.jpg");
    await addFile(lab, source, sha(63), "s63.jpg");
    await addLabel(lab, sha(60), { name: "Vouched and failed", outcome: "failed", status: "accepted", date: "2026-11-10" });
    await addLabel(lab, sha(61), { name: "Only the model's guess", outcome: "failed", status: "check" });
    await addLabel(lab, sha(62), { name: "Notebook page 1", outcome: "worked", status: "check", date: "2026-11-11" });
    await addLabel(lab, sha(63), { name: "Notebook page 2", status: "check" });
    const note = (await owner("insert into notes (lab_id, state, reason, origin) values ($1, 'confirmed', 'Uploaded together', 'batch:t') returning id", [lab])).rows[0]?.id;
    await owner("insert into note_pages (note_id, lab_id, sha256, position) values ($1, $2, $3, 1), ($1, $2, $4, 2)", [note, lab, sha(62), sha(63)]);

    const offered = RunSuggestionsJson.parse(await rows(ada, "run_suggestions($1, 100)", [lab]));
    const byTitle = new Map(offered.map((s) => [s.title, s]));
    expect(byTitle.get("Vouched and failed")).toMatchObject({ shas: [sha(60)], fileSays: "failed" });
    expect(byTitle.get("Notebook page 1")).toMatchObject({ key: `note:${note}`, shas: [sha(62), sha(63)] });
    expect(byTitle.has("Only the model's guess")).toBe(false);
    expect(byTitle.has("Notebook page 2")).toBe(false);
    // A file already in a run isn't offered again; nor is another lab's.
    expect(byTitle.has("Drug A plate 1")).toBe(false);
    expect(byTitle.has("Their run")).toBe(false);
    expect(await count("runs where title = 'Vouched and failed'")).toBe(0);

    await create(ada, lab, [sha(60)]);
    expect(RunSuggestionsJson.parse(await rows(ada, "run_suggestions($1, 100)", [lab])).map((s) => s.title)).not.toContain("Vouched and failed");

    expect(await codeOf(call(cy, "dismiss_run_suggestions($1)", [lab]))).toBe("42501");
    await call(ada, "dismiss_run_suggestions($1)", [lab]);
    await call(ada, "dismiss_run_suggestions($1)", [lab]);
    expect(await rows(ada, "run_suggestions($1, 100)", [lab])).toEqual([]);
    expect(RunSuggestionsJson.parse(await rows(ben, "run_suggestions($1, 100)", [lab])).length).toBeGreaterThan(0);
    expect(await rows(cy, "run_suggestions($1, 100)", [lab])).toEqual([]);
  });
});

describe("the log", () => {
  it("says a change with no signed-in user came from the worker", async () => {
    const run = await create(ada, lab, [sha(1)]);
    await owner("update runs set title = 'Renamed by a job' where id = $1", [run.id]);
    expect((await logOf(run.id)).at(-1)).toMatchObject({ action: "run.edit", via: "worker", actor: null, before: { title: "Drug A plate 1" }, after: { title: "Renamed by a job" } });
  });

  it("writes nothing when nothing changed", async () => {
    const run = await create(ada, lab, [sha(1)]);
    const before = (await logOf(run.id)).length;
    await setStatus(ada, run.id, "failed");
    RunJson.parse(await call(ada, "edit_run($1, $2::jsonb)", [run.id, JSON.stringify({ title: "Drug A plate 1" })]));
    expect((await logOf(run.id)).length).toBe(before);
  });
});

describe("edit_run", () => {
  it("changes only the fields given, for members of the lab", async () => {
    const run = await create(ada, lab, [sha(1)]);
    const edited = RunJson.parse(await call(ben, "edit_run($1, $2::jsonb)", [run.id, JSON.stringify(fieldArgs({ title: "Plate 1, second look", personId: null }))]));
    expect(edited).toMatchObject({ title: "Plate 1, second look", person: null, startedOn: "2026-11-02", experiment: { id: hela } });
    expect(await codeOf(call(ada, "edit_run($1, $2::jsonb)", [run.id, JSON.stringify({ title: "  " })]))).toBe("BL908");
    expect(await codeOf(call(ada, "edit_run($1, $2::jsonb)", [run.id, JSON.stringify({ experiment_id: theirs })]))).toBe("BL905");
    expect(await codeOf(call(ada, "edit_run($1, $2::jsonb)", [run.id, JSON.stringify({ ended_on: "2026-01-01" })]))).toBe("23514");
    expect(await codeOf(call(cy, "edit_run($1, $2::jsonb)", [run.id, JSON.stringify({ title: "Mine now" })]))).toBe("42501");
  });
});

// Sharing is switched by slice C's functions; here the worker's connection flips the switches
// so the triggers are tested by themselves.
describe("consent is rechecked in the database", () => {
  const grant = async (labId: LabId, runId: RunId, action = "export.allowed", age = "0 minutes") =>
    Number((await owner(`insert into run_log (lab_id, run_id, via, action, at) values ($1, $2, 'person', $3, now() - $4::interval) returning id`, [labId, runId, action, age])).rows[0]?.id);
  const build = (labId: LabId, runId: RunId, grantId: number) =>
    owner("insert into task_exports (lab_id, run_id, grant_id, purpose) values ($1, $2, $3, 'task folder') returning id", [labId, runId, grantId]).then((r) => z.string().parse(r.rows[0]?.id));
  const agree = (labId: LabId, on: boolean) =>
    owner("update labs set sharing_agreed_at = $2, sharing_agreement = $3 where id = $1", [labId, on ? new Date().toISOString() : null, on ? "v1" : null]);
  const share = (runId: RunId, on: boolean) => owner("update runs set share = $2 where id = $1", [runId, on]);

  it("refuses an export row when the run's switch is off, the lab's is off, or the lab is a demo lab", async () => {
    const run = await create(ada, lab, [sha(1)]);
    const g = await grant(lab, run.id);
    await agree(lab, false);
    expect(await codeOf(build(lab, run.id, g))).toBe("BL951");
    await agree(lab, true);
    expect(await codeOf(build(lab, run.id, g))).toBe("BL951");
    await agree(lab, false);
    await share(run.id, true);
    expect(await codeOf(build(lab, run.id, g))).toBe("BL951");
    await agree(lab, true);
    await owner("update labs set plan = 'demo' where id = $1", [lab]);
    expect(await codeOf(build(lab, run.id, g))).toBe("BL951");
    await owner("update labs set plan = 'pilot' where id = $1", [lab]);
    expect(await count("task_exports where run_id = $1", [run.id])).toBe(0);
    expect(typeof (await build(lab, run.id, g))).toBe("string");
  });

  it("needs a grant made for this run, allowed, fresh and not used before", async () => {
    await agree(lab, true);
    const run = await create(ada, lab, [sha(1)]);
    const other = await create(ada, lab, [sha(2)]);
    await share(run.id, true);
    await share(other.id, true);
    expect(await codeOf(build(lab, run.id, 999999999))).toBe("BL952");
    expect(await codeOf(build(lab, run.id, await grant(lab, run.id, "export.blocked")))).toBe("BL952");
    expect(await codeOf(build(lab, run.id, await grant(lab, other.id)))).toBe("BL952");
    expect(await codeOf(build(lab, run.id, await grant(lab, run.id, "export.allowed", "61 minutes")))).toBe("BL952");
    const g = await grant(lab, run.id, "export.allowed", "59 minutes");
    await build(lab, run.id, g);
    expect(await codeOf(build(lab, run.id, g))).toBe("23505");
  });

  it("turns a shared run's sharing off when its files, status or causes change, and withdraws the folder", async () => {
    await agree(lab, true);
    const run = await create(ada, lab, [sha(1)]);
    await share(run.id, true);
    const task = await build(lab, run.id, await grant(lab, run.id));
    await owner("insert into task_model_runs (task_id, lab_id, model) values ($1, $2, 'model-a')", [task, lab]);
    await owner("select assert_exportable($1)", [task]);

    await call(ben, "add_run_files($1, $2)", [run.id, [sha(2)]]);
    expect((await read(ada, run.id))?.share).toBe(false);
    expect((await logOf(run.id)).at(-1)).toMatchObject({ action: "run.share", via: "trigger", actor: ben, before: { share: true }, after: { share: false } });
    expect(await count("task_exports where id = $1 and withdrawn_at is not null", [task])).toBe(1);
    expect(await codeOf(owner("insert into task_model_runs (task_id, lab_id, model) values ($1, $2, 'model-b')", [task, lab]))).toBe("BL951");
    expect(await codeOf(owner("select assert_exportable($1)", [task]))).toBe("BL951");
    expect(await codeOf(owner("update task_exports set withdrawn_at = null where id = $1", [task]))).toBe("BL952");

    for (const change of [
      () => setStatus(ada, run.id, "odd"),
      () => owner("update runs set suspected_cause = 'the buffer' where id = $1", [run.id]),
      () => owner("update runs set aim = 'to see the band' where id = $1", [run.id]),
      () => call(ada, "remove_run_file($1, $2)", [run.id, sha(2)]),
    ]) {
      await share(run.id, true);
      await change();
      expect((await read(ada, run.id))?.share).toBe(false);
      expect((await logOf(run.id)).at(-1)).toMatchObject({ action: "run.share", via: "trigger", after: { share: false } });
    }
    // Turning it on by itself stays on, and is the person's (here the worker's) doing.
    await share(run.id, true);
    expect((await read(ada, run.id))?.share).toBe(true);
    expect((await logOf(run.id)).at(-1)).toMatchObject({ action: "run.share", via: "worker", after: { share: true } });
  });

  it("withdraws every folder and logs it when the lab's agreement goes off", async () => {
    await agree(lab, true);
    const run = await create(ada, lab, [sha(1)]);
    await share(run.id, true);
    const task = await build(lab, run.id, await grant(lab, run.id));
    await agree(lab, false);
    expect(await count("task_exports where id = $1 and withdrawn_at is not null", [task])).toBe(1);
    expect(await codeOf(owner("select assert_exportable($1)", [task]))).toBe("BL951");
    const last = (await owner("select action, via, before, after from run_log where lab_id = $1 and run_id is null order by id desc limit 1", [lab])).rows[0];
    expect(last).toMatchObject({ action: "lab.share", via: "worker", before: { agreement: "v1" }, after: { agreement: null } });
  });

  it("keeps the worker's functions and the export tables from members", async () => {
    await agree(lab, true);
    const run = await create(ada, lab, [sha(1)]);
    await share(run.id, true);
    const g = await grant(lab, run.id);
    expect(await codeOf(asUser(ada, () => db.query("insert into task_exports (lab_id, run_id, grant_id, purpose) values ($1, $2, $3, 'x')", [lab, run.id, g])))).toBe("42501");
    expect(await codeOf(asUser(ada, () => db.query("insert into run_log (lab_id, run_id, via, action) values ($1, $2, 'person', 'export.allowed')", [lab, run.id])))).toBe("42501");
    expect(await codeOf(asUser(ada, () => db.query("update runs set share = true where id = $1", [run.id])))).toBe("42501");
    expect(await codeOf(asUser(ada, () => db.query("update labs set sharing_agreed_at = now(), sharing_agreement = 'v1' where id = $1", [lab])))).toBe("42501");
    expect(await codeOf(asUser(ada, () => db.query("select assert_exportable($1)", [run.id])))).toBe("42501");
    expect(await codeOf(asUser(ada, () => db.query("select run_export_blocks($1)", [run.id])))).toBe("42501");
    const task = await build(lab, run.id, g);
    expect((await asUser(cy, () => db.query("select id from task_exports where id = $1", [task]))).rows).toEqual([]);
    await agree(lab, false);
  });
});

describe("grants", () => {
  it("gives members exactly the run functions meant for them, and signed-out callers none", async () => {
    const added = z.array(z.object({ name: z.string(), member: z.boolean(), anon: z.boolean() })).parse(
      (
        await owner(
          `select p.proname as name, has_function_privilege('authenticated', p.oid, 'execute') as member,
             has_function_privilege('anon', p.oid, 'execute') as anon
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.oid >= (select min(oid) from pg_proc where proname = 'run_files_check')
             and p.oid <= (select max(oid) from pg_proc where proname = 'run_file')
           order by 1`,
        )
      ).rows,
    );
    expect(added.filter((f) => f.anon)).toEqual([]);
    const later = z.array(z.object({ name: z.string() })).parse(
      (
        await owner(
          `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.oid > (select max(oid) from pg_proc where proname = 'run_file')
             and has_function_privilege('anon', p.oid, 'execute')`,
        )
      ).rows,
    );
    expect(later).toEqual([]);
    expect(added.filter((f) => f.member).map((f) => f.name)).toEqual([
      "add_run_files", "create_run", "dismiss_run_suggestions", "edit_run", "file_runs", "is_recording", "lab_runs", "link_retry",
      "remove_run_file", "retry_candidates", "run_file", "run_json", "run_ref_json", "run_suggestions", "set_run_status",
    ]);
    expect(added.filter((f) => !f.member).map((f) => f.name)).toEqual([
      "assert_exportable", "labs_sharing_log", "member_run", "put_run_files", "run_export_blocks", "run_files_check", "run_files_log",
      "run_via", "runs_before_update", "runs_log", "task_exports_check", "task_model_runs_check",
    ]);
  });
});

describe("the failure list", () => {
  it("ships version 1 as a draft, readable by anyone signed in and written by no one", async () => {
    const terms = z.array(z.object({ code: z.string() })).parse((await asUser(dee, () => db.query("select code from failure_terms where version = 1"))).rows);
    const kinds = (prefix: string) => terms.filter((t) => t.code.startsWith(prefix)).length;
    expect([kinds("tech."), kinds("step."), kinds("cause.")]).toEqual([21, 10, 13]);
    expect((await asUser(dee, () => db.query("select signed_off_at from failure_taxonomies where version = 1"))).rows).toEqual([{ signed_off_at: null }]);
    expect(await codeOf(asUser(ada, () => db.query("insert into failure_terms (version, code, label, position) values (1, 'cause.mine', 'Mine', 99)")))).toBe("42501");
    expect(await codeOf(asRole("anon", null, () => db.query("select code from failure_terms")))).toBe("42501");
  });
});

describe("deleting", () => {
  it("won't delete a person named as a confirmer", async () => {
    const run = await create(ada, lab, [sha(1)]);
    const pi = (await owner("insert into people (lab_id, display_name) values ($1, 'Dr Okafor') returning id", [lab])).rows[0]?.id;
    await owner("update runs set confirmed_cause = 'dead antibody', confirmed_by = $2, confirm_method = 'pi_opinion', confirmed_at = now() where id = $1", [run.id, pi]);
    expect(await codeOf(owner("delete from people where id = $1", [pi]))).toBe("23503");
  });

  it("takes a lab's runs, debriefs and exports with the lab", async () => {
    const doomed = LabId.parse(CreateLabResult.parse(await call(dee, "create_lab('Doomed lab')", [])));
    const src = (await owner("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/d') returning id", [doomed])).rows[0]?.id;
    const audio = await addFile(doomed, src, sha(70), "answer.webm");
    await addFile(doomed, src, sha(71), "plate.csv");
    await addFile(doomed, src, sha(72), "control.csv");
    const pi = (await owner("insert into people (lab_id, display_name, member_user_id) values ($1, 'Dee', $2) returning id", [doomed, dee])).rows[0]?.id;
    const exp = (await owner("insert into experiments (lab_id, name) values ($1, 'Doomed') returning id", [doomed])).rows[0]?.id;
    const first = await create(dee, doomed, [sha(71), sha(72)], { status: "failed", experimentId: ExperimentId.parse(exp) });
    const second = await create(dee, doomed, [sha(72)], { retryOf: first.id });
    await owner(
      `update runs set suspected_cause = 'x', confirmed_cause = 'y', confirmed_by = $2, confirm_method = 'repeat', confirm_run = $3,
        confirm_sha256 = $4, confirmed_at = now(), confirmer_attested_at = now(), taxonomy_version = 1, cause_category = 'cause.reagent', share = true where id = $1`,
      [first.id, pi, second.id, sha(72)],
    );
    const debrief = (await owner("insert into run_debriefs (run_id, lab_id, started_by) values ($1, $2, $3) returning id", [first.id, doomed, dee])).rows[0]?.id;
    await owner("insert into run_debrief_answers (debrief_id, lab_id, question, location_id, text) values ($1, $2, 1, $3, 'we wanted a band')", [debrief, doomed, audio]);
    await owner("insert into run_rubrics (run_id, lab_id, question) values ($1, $2, 'Why did it fail?')", [first.id, doomed]);
    await owner("insert into run_reviews (run_id, lab_id, reviewer_id, notes) values ($1, $2, $3, 'agreed')", [first.id, doomed, pi]);
    await owner("insert into export_exclusions (lab_id, kind, value) values ($1, 'tag', 'patient')", [doomed]);
    await call(dee, "dismiss_run_suggestions($1)", [doomed]);
    await owner("update labs set sharing_agreed_at = now(), sharing_agreement = 'v1', sharing_agreed_by = $2 where id = $1", [doomed, dee]);
    const g = await owner("insert into run_log (lab_id, run_id, via, action) values ($1, $2, 'person', 'export.allowed') returning id", [doomed, first.id]);
    const task = (await owner("insert into task_exports (lab_id, run_id, grant_id, purpose) values ($1, $2, $3, 'task') returning id", [doomed, first.id, g.rows[0]?.id])).rows[0]?.id;
    await owner("insert into task_model_runs (task_id, lab_id, model) values ($1, $2, 'model-a')", [task, doomed]);

    const tables = ["runs", "run_files", "run_log", "run_debriefs", "run_debrief_answers", "run_suggestion_dismissals", "export_exclusions", "run_rubrics", "run_reviews", "task_exports", "task_model_runs"];
    for (const t of tables) expect(await count(`${t} where lab_id = $1`, [doomed]), t).toBeGreaterThan(0);
    await owner("delete from labs where id = $1", [doomed]);
    for (const t of tables) expect(await count(`${t} where lab_id = $1`, [doomed]), t).toBe(0);
  });
});
