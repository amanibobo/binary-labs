import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { PlanBodiesJson, PlanChoicesJson } from "../as-run";
import { CreateLabResult } from "../domain";
import { ExperimentId, LabId, ProtocolVersionId, RunId, Sha256 } from "../ids";
import { fieldArgs, RunJson, type NewRunFields } from "../run-record";
import { EditedFilesJson } from "../run-originals";

// Planned versus actual and the run's edited files (0036) against the real migrations: as
// members of the lab, as a member of another lab, signed out, and as the worker's connection.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ada = "00000000-0000-4000-8000-0000000e0001";
const ben = "00000000-0000-4000-8000-0000000e0002";
const cy = "00000000-0000-4000-8000-0000000e0003";
const sha = (n: number) => Sha256.parse(`e${n.toString(16).padStart(63, "0")}`);

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
const one = z.object({ v: z.unknown() });
const call = (userId: string, sql: string, params: unknown[]) =>
  asRole("authenticated", userId, async () => one.parse((await db.query(`select ${sql} as v`, params)).rows[0]).v);
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);
const owner = (sql: string, params: unknown[] = []) => db.query(sql, params);

let lab: LabId;
let otherLab: LabId;
let hela: ExperimentId;
let source: string;
// The experiment's protocol, three versions saved 1, 10 and 20 October.
let v1: ProtocolVersionId;
let v2: ProtocolVersionId;
let v3: ProtocolVersionId;
let bradford: ProtocolVersionId;
let theirs: ProtocolVersionId;
const places = new Map<Sha256, string>();

async function addFile(labId: LabId, sourceId: string, s: Sha256, name: string) {
  await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/csv', 'spreadsheet') on conflict do nothing", [s]);
  const res = await owner(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, $3, '/' || $3, $3, 10, '2026-10-14T12:00:00Z', 'r', $4, 'indexed') returning id`,
    [labId, sourceId, name, s],
  );
  const id = z.string().parse(res.rows[0]?.id);
  places.set(s, id);
  return id;
}
// The file at the place that held `from` is saved again in the lab's folder with `to`.
async function editFile(from: Sha256, to: Sha256, at: string) {
  await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, 11, 'text/csv', 'spreadsheet') on conflict do nothing", [to]);
  await owner("update file_locations set sha256 = $2, modified_at = $3 where id = $1", [places.get(from), to, at]);
}

const VersionRow = z.object({ version_id: ProtocolVersionId });
async function protocol(userId: string, labId: LabId, title: string, bodies: string[], savedOn: string[]): Promise<ProtocolVersionId[]> {
  const [first, ...rest] = bodies;
  const made = VersionRow.extend({ protocol_id: z.string() }).parse(
    (await asRole("authenticated", userId, () => db.query("select * from create_protocol($1, 'protocol', $2, $3)", [labId, title, first]))).rows[0],
  );
  const ids = [made.version_id];
  for (const body of rest) {
    const saved = VersionRow.parse(
      (await asRole("authenticated", userId, () => db.query("select * from save_protocol($1, $2, $3, $4)", [made.protocol_id, ids.at(-1), title, body]))).rows[0],
    );
    ids.push(saved.version_id);
  }
  for (const [i, id] of ids.entries()) await owner("update protocol_versions set created_at = $2 where id = $1", [id, savedOn[i]]);
  return ids;
}

const create = (userId: string, shas: Sha256[], fields: NewRunFields = {}) =>
  call(userId, "create_run($1, $2, $3::jsonb)", [lab, shas, JSON.stringify(fieldArgs(fields))]).then((r) => RunJson.parse(r));
const edited = (userId: string, id: RunId) => call(userId, "run_edited_files($1)", [id]);
const choices = (userId: string, id: RunId, q = "") => call(userId, "run_plan_choices($1, $2, 12)", [id, q]);
const setPlan = (userId: string, id: RunId, version: string | null) => call(userId, "set_run_plan($1, $2)", [id, version]).then((r) => RunJson.parse(r));
const saveAsRun = (userId: string, id: RunId, body: string, basedOn: string | null) =>
  call(userId, "save_as_run($1, $2, $3)", [id, body, basedOn]).then((r) => RunJson.parse(r));
const logCount = async (id: RunId) => Number((await owner("select count(*) as n from run_log where run_id = $1 and action = 'run.edit'", [id])).rows[0]?.n);

const STEPS_1 = "## Steps\n\n1. Thaw the pellet.\n2. Spin at 12,000 g.\n";
const STEPS_2 = "## Steps\n\n1. Thaw the pellet on ice.\n2. Spin at 12,000 g.\n";
const STEPS_3 = "## Steps\n\n1. Thaw the pellet on ice.\n2. Spin at 15,000 g.\n";

beforeAll(async () => {
  await db.connect();
  await owner("insert into auth.users (id, email) values ($1, 'ada@evidence.test'), ($2, 'ben@evidence.test'), ($3, 'cy@evidence.test')", [ada, ben, cy]);
  lab = LabId.parse(CreateLabResult.parse(await call(ada, "create_lab('Evidence lab')", [])));
  otherLab = LabId.parse(CreateLabResult.parse(await call(cy, "create_lab('Other evidence lab')", [])));
  await owner("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, ben]);
  source = (await owner("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/e') returning id", [lab])).rows[0]?.id;
  for (let n = 1; n <= 6; n += 1) await addFile(lab, source, sha(n), `plate${n}.csv`);

  [v1, v2, v3] = (await protocol(ben, lab, "BM3 purification", [STEPS_1, STEPS_2, STEPS_3], ["2026-10-01T09:00:00Z", "2026-10-10T09:00:00Z", "2026-10-20T09:00:00Z"])) as [
    ProtocolVersionId,
    ProtocolVersionId,
    ProtocolVersionId,
  ];
  [bradford] = (await protocol(ben, lab, "Bradford assay", ["1. Mix.\n"], ["2026-09-01T09:00:00Z"])) as [ProtocolVersionId];
  const [archived] = await protocol(ben, lab, "Old Bradford", ["1. Mix.\n"], ["2026-09-01T09:00:00Z"]);
  await call(ada, "archive_protocol($1)", [(await owner("select protocol_id from protocol_versions where id = $1", [archived])).rows[0]?.protocol_id]);
  await asRole("authenticated", ben, () => db.query("select * from create_protocol($1, 'tutorial', 'Using the sonicator', 'Hold it.')", [lab]));
  [theirs] = (await protocol(cy, otherLab, "Their purification", ["1. Secret.\n"], ["2026-10-01T09:00:00Z"])) as [ProtocolVersionId];

  hela = ExperimentId.parse(
    (await owner("insert into experiments (lab_id, name, protocol_id) values ($1, 'BM3', (select protocol_id from protocol_versions where id = $2)) returning id", [lab, v1])).rows[0]?.id,
  );
});

afterAll(async () => {
  await db.end();
});

describe("run_edited_files", () => {
  it("lists a run's file whose place now holds a later version, with the version the run keeps", async () => {
    const run = await create(ben, [sha(1), sha(2)]);
    await editFile(sha(1), sha(11), "2026-10-20T08:00:00Z");
    const iso = (at: string) => new Date(at).toISOString();
    expect(EditedFilesJson.parse(await edited(ben, run.id)).map((f) => ({ ...f, heldAt: iso(f.heldAt), latestAt: iso(f.latestAt) }))).toEqual([
      { sha256: sha(1), locationId: places.get(sha(1)), heldVersion: 1, heldAt: "2026-10-14T12:00:00.000Z", latestVersion: 2, latestAt: "2026-10-20T08:00:00.000Z" },
    ]);
    const read = RunJson.parse(await call(ben, "run_json($1)", [run.id]));
    expect(read.files.find((f) => f.sha256 === sha(1))?.locationId).toBe(places.get(sha(1)));
  });

  it("leaves out a file edited back to the run's content, and one gone from the lab's folder", async () => {
    const run = await create(ben, [sha(3), sha(4)]);
    await editFile(sha(3), sha(13), "2026-10-20T08:00:00Z");
    places.set(sha(13), z.string().parse(places.get(sha(3))));
    await editFile(sha(13), sha(3), "2026-10-21T08:00:00Z");
    await owner("update file_locations set deleted_at = now() where id = $1", [places.get(sha(4))]);
    expect(await edited(ben, run.id)).toEqual([]);
  });

  it("is null for another lab's member and refused signed out", async () => {
    const run = await create(ben, [sha(5)]);
    await editFile(sha(5), sha(15), "2026-10-20T08:00:00Z");
    expect(await edited(cy, run.id)).toBeNull();
    expect(await codeOf(asRole("anon", null, () => db.query("select run_edited_files($1)", [run.id])))).toBe("42501");
  });
});

describe("run_plan_choices", () => {
  it("puts the newest version saved by the run's day first, then the experiment's other versions, then the lab's protocols", async () => {
    const run = await create(ben, [sha(6)], { startedOn: "2026-10-15", experimentId: hela });
    const list = PlanChoicesJson.parse(await choices(ben, run.id));
    expect(list.map((c) => [c.versionId, c.suggested, c.picked, c.current])).toEqual([
      [v2, true, false, false],
      [v3, false, false, true],
      [v1, false, false, false],
      [bradford, false, false, true],
    ]);
    expect(PlanChoicesJson.parse(await choices(ben, run.id, "brad")).map((c) => c.title)).toEqual(["Bradford assay"]);
    expect(await choices(cy, run.id)).toBeNull();
  });

  it("suggests version 1 for a run older than every version, and the newest for a run with no day", async () => {
    const early = await create(ben, [sha(6)], { startedOn: "2026-09-02", experimentId: hela });
    expect(PlanChoicesJson.parse(await choices(ben, early.id))[0]).toMatchObject({ versionId: v1, suggested: true });
    const undated = await create(ben, [sha(6)], { experimentId: hela });
    expect(PlanChoicesJson.parse(await choices(ben, undated.id))[0]).toMatchObject({ versionId: v3, suggested: true });
    const noExperiment = await create(ben, [sha(6)]);
    expect(PlanChoicesJson.parse(await choices(ben, noExperiment.id)).map((c) => [c.title, c.suggested])).toEqual([
      ["BM3 purification", false],
      ["Bradford assay", false],
    ]);
  });

  it("puts the picked version second, marked", async () => {
    const run = await create(ben, [sha(6)], { startedOn: "2026-10-15", experimentId: hela });
    await setPlan(ben, run.id, bradford);
    expect(PlanChoicesJson.parse(await choices(ben, run.id)).map((c) => [c.versionId, c.picked])).toEqual([
      [v2, false],
      [bradford, true],
      [v3, false],
      [v1, false],
    ]);
  });

  it("isn't the members' to call for the suggestion alone", async () => {
    const run = await create(ben, [sha(6)]);
    expect(await codeOf(call(ben, "run_suggested_version($1)", [run.id]))).toBe("42501");
  });
});

describe("set_run_plan", () => {
  it("picks the version the run was planned from, and takes it away", async () => {
    const run = await create(ben, [sha(6)], { experimentId: hela });
    const planned = await setPlan(ada, run.id, v2);
    expect(planned.plan.planned).toEqual({ versionId: v2, protocolId: expect.any(String), title: "BM3 purification", version: 2 });
    expect((await setPlan(ada, run.id, null)).plan.planned).toBeNull();
  });

  it("refuses another lab's version, another lab's member, and a run that isn't there", async () => {
    const run = await create(ben, [sha(6)]);
    expect(await codeOf(setPlan(ben, run.id, theirs))).toBe("BL921");
    expect(await codeOf(setPlan(cy, run.id, theirs))).toBe("42501");
    expect(await codeOf(setPlan(ben, RunId.parse("00000000-0000-4000-8000-00000000dead"), v1))).toBe("BL907");
  });
});

describe("save_as_run", () => {
  it("saves what was done with the version it started from and who said so, once", async () => {
    const run = await create(ben, [sha(6)], { experimentId: hela });
    await setPlan(ben, run.id, v2);
    const before = await logCount(run.id);
    const saved = await saveAsRun(ben, run.id, STEPS_3, v2);
    expect(saved.plan.asRun).toEqual({ body: STEPS_3, basedOn: v2, by: ben, at: expect.any(String) });
    expect(await logCount(run.id)).toBe(before + 1);
    await saveAsRun(ada, run.id, STEPS_3, v2);
    expect(await logCount(run.id)).toBe(before + 1);
    expect(await call(ben, "run_plan_bodies($1)", [run.id]).then((b) => PlanBodiesJson.parse(b))).toEqual({
      planned: STEPS_2,
      basedOn: { versionId: v2, title: "BM3 purification", version: 2, body: STEPS_2 },
    });
  });

  it("clears it when the text is empty", async () => {
    const run = await create(ben, [sha(6)]);
    await saveAsRun(ben, run.id, "1. Did it.", null);
    expect((await saveAsRun(ben, run.id, "  \n ", v1)).plan.asRun).toBeNull();
    expect(await call(ben, "run_plan_bodies($1)", [run.id])).toEqual({ planned: null, based_on: null });
  });

  it("refuses a text over 200,000 characters, another lab's version and another lab's member", async () => {
    const run = await create(ben, [sha(6)]);
    expect(await codeOf(saveAsRun(ben, run.id, "x".repeat(200_001), null))).toBe("BL922");
    expect(await codeOf(saveAsRun(ben, run.id, "1. Did it.", theirs))).toBe("BL921");
    expect(await codeOf(saveAsRun(cy, run.id, "1. Did it.", null))).toBe("42501");
    expect(await call(cy, "run_plan_bodies($1)", [run.id])).toBeNull();
  });
});
