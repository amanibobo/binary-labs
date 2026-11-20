import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { BulkResultRow, planBulk, UndoBatchRow, type BulkChange } from "../bulk-labels";
import { CorrectionRows, CreateLabResult, LabelRow, type Label } from "../domain";
import { ExperimentId, LabId, PersonId, Sha256 } from "../ids";
import { RepeatCandidates } from "../labels";

// Changing many labels at once, skipping a voice note's question and linking repeats, against
// the real migrations as lab members with RLS on.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ada = "00000000-0000-4000-8000-0000000e0001";
const ben = "00000000-0000-4000-8000-0000000e0002";
const cy = "00000000-0000-4000-8000-0000000e0003";
const sha = (n: number) => Sha256.parse(`e${n.toString(16).padStart(63, "0")}`);

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
const labelOf = async (userId: string, s: Sha256): Promise<Label> => LabelRow.parse(await call(userId, "label_json($1, $2)", [lab, s]));
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

let lab: LabId;
let otherLab: LabId;
let hela: ExperimentId;
let gels: ExperimentId;
let theirs: ExperimentId;
let priya: PersonId;
let source: string;

async function addFile(labId: LabId, sourceId: string, s: Sha256, name: string) {
  await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/csv', 'spreadsheet') on conflict do nothing", [s]);
  await db.query(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, $3, '/' || $3, $3, 10, now(), 'r', $4, 'indexed')`,
    [labId, sourceId, name, s],
  );
}

type Seed = { name: string | null; status?: string; experiment?: string | null; date?: string | null; tags?: string[]; followUp?: object | null };
async function addLabel(labId: LabId, s: Sha256, seed: Seed) {
  await db.query(
    `insert into labels (lab_id, sha256, status, clean_name, experiment_id, person_id, date, tags, confidence, source, outcome, follow_up)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 0.8, 'model', 'worked', $9)`,
    [
      labId,
      s,
      seed.status ?? (seed.name === null ? "needs_look" : "check"),
      seed.name,
      seed.experiment ?? null,
      labId === lab ? priya : null,
      seed.date ?? null,
      seed.tags ?? [],
      seed.followUp === undefined || seed.followUp === null ? null : JSON.stringify(seed.followUp),
    ],
  );
}

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'ada@many.test'), ($2, 'ben@many.test'), ($3, 'cy@many.test')", [ada, ben, cy]);
  lab = LabId.parse(CreateLabResult.parse(await call(ada, "create_lab('Many labels lab')", [])));
  otherLab = LabId.parse(CreateLabResult.parse(await call(cy, "create_lab('Other many lab')", [])));
  await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, ben]);
  await asUser(ada, async () => {
    hela = ExperimentId.parse((await db.query("insert into experiments (lab_id, name) values ($1, 'HeLa drug A') returning id", [lab])).rows[0]?.id);
    gels = ExperimentId.parse((await db.query("insert into experiments (lab_id, name) values ($1, 'Gels') returning id", [lab])).rows[0]?.id);
    priya = PersonId.parse((await db.query("insert into people (lab_id, display_name) values ($1, 'Priya') returning id", [lab])).rows[0]?.id);
  });
  await asUser(cy, async () => {
    theirs = ExperimentId.parse((await db.query("insert into experiments (lab_id, name) values ($1, 'Secret') returning id", [otherLab])).rows[0]?.id);
  });
  source = (await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/m') returning id", [lab])).rows[0]?.id;
  const otherSource = (await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/o') returning id", [otherLab])).rows[0]?.id;
  for (let n = 1; n <= 9; n += 1) await addFile(lab, source, sha(n), `run${n}.csv`);
  await addFile(otherLab, otherSource, sha(50), "theirs.csv");
  await addLabel(lab, sha(1), { name: "Drug A run 1", experiment: hela, date: "2026-10-01" });
  await addLabel(lab, sha(2), { name: "Drug A run 2", experiment: hela, date: "2026-10-08" });
  await addLabel(lab, sha(3), { name: "Drug A run 3", experiment: gels, date: "2026-10-15", tags: ["plate 3"] });
  await addLabel(lab, sha(4), { name: null });
  await addLabel(lab, sha(5), { name: "Tagged full", tags: Array.from({ length: 20 }, (_, i) => `t${i}`) });
  await addLabel(lab, sha(6), {
    name: "Voice note",
    followUp: { field: "experiment", question: "Which experiment was this?", choices: [{ label: "HeLa drug A", value: hela }] },
  });
  await addLabel(lab, sha(7), { name: "Gel 7", experiment: gels, date: "2026-09-01" });
  await addLabel(lab, sha(8), { name: "Old drug A pilot", experiment: hela, date: "2026-06-01" });
  await addLabel(lab, sha(9), { name: "Drug A gone" });
  await db.query("update file_locations set deleted_at = now() where sha256 = $1", [sha(9)]);
  await addLabel(otherLab, sha(50), { name: "Their run" });
});

afterAll(async () => {
  await db.end();
});

const bulk = (userId: string, shas: Sha256[], change: { field: string; value: string | null }) =>
  call(userId, "correct_labels($1, $2, $3::jsonb)", [lab, shas, JSON.stringify(change)]).then((r) => BulkResultRow.parse(r));

describe("correct_labels", () => {
  it("changes only the chosen field on the files that need it, and counts the rest as the client plans it", async () => {
    const shas = [sha(1), sha(2), sha(3), sha(4), sha(3)];
    const before = [];
    for (const s of [sha(1), sha(2), sha(3), sha(4)]) before.push({ sha256: s, label: await labelOf(ada, s) });
    const change: BulkChange = { field: "experiment", value: { id: gels, name: "Gels" } };
    const plan = planBulk(before, change);

    const result = await bulk(ada, shas, { field: "experiment", value: gels });
    expect(result.changed.map((c) => c.sha256)).toEqual([sha(1), sha(2)]);
    expect({ same: result.same, unnamed: result.unnamed, full: result.full }).toEqual({ same: 1, unnamed: 1, full: 0 });
    expect({ same: plan.same, unnamed: plan.unnamed, full: plan.full, changed: plan.changes.length }).toEqual({ same: 1, unnamed: 1, full: 0, changed: 2 });
    expect(result.batchId).not.toBeNull();

    for (const { sha256, label } of result.changed) {
      const planned = plan.changes.find((c) => c.sha256 === sha256)?.draft;
      expect(label.experiment?.id).toBe(gels);
      expect(label.status).toBe("corrected");
      // Everything else stays as it was.
      expect({ name: label.cleanName, date: label.date, person: label.person?.id, outcome: label.outcome, tags: label.tags }).toEqual({
        name: planned?.cleanName,
        date: planned?.date,
        person: planned?.person?.id,
        outcome: planned?.outcome,
        tags: planned?.tags,
      });
    }
    const third = await labelOf(ada, sha(3));
    expect(third.status).toBe("check");
  });

  it("adds a tag, skipping files that have it or are full, and removes it again", async () => {
    const added = await bulk(ada, [sha(3), sha(5), sha(7)], { field: "add_tag", value: "plate 3" });
    expect(added.changed.map((c) => c.sha256)).toEqual([sha(7)]);
    expect({ same: added.same, full: added.full }).toEqual({ same: 1, full: 1 });
    expect((await labelOf(ada, sha(7))).tags).toEqual(["plate 3"]);

    const removed = await bulk(ada, [sha(3), sha(7), sha(1)], { field: "remove_tag", value: "plate 3" });
    expect(removed.changed.map((c) => c.sha256)).toEqual([sha(3), sha(7)]);
    expect(removed.same).toBe(1);
    expect((await labelOf(ada, sha(3))).tags).toEqual([]);
  });

  it("sets and clears an outcome and a date", async () => {
    const failed = await bulk(ada, [sha(1), sha(2)], { field: "outcome", value: "failed" });
    expect(failed.changed.map((c) => c.label.outcome)).toEqual(["failed", "failed"]);
    const cleared = await bulk(ada, [sha(1)], { field: "date", value: null });
    expect(cleared.changed[0]?.label.date).toBeNull();
  });

  it("refuses another lab's experiment, an unknown field, too many files and a non-member", async () => {
    expect(await codeOf(bulk(ada, [sha(1)], { field: "experiment", value: theirs }))).toBe("BL802");
    expect(await codeOf(bulk(ada, [sha(1)], { field: "name", value: "x" }))).toBe("BL801");
    expect(await codeOf(bulk(ada, [sha(1)], { field: "date", value: "Oct 1" }))).toBe("BL801");
    expect(await codeOf(bulk(ada, Array.from({ length: 201 }, (_, i) => sha(i + 100)), { field: "outcome", value: null }))).toBe("BL803");
    expect(await codeOf(bulk(cy, [sha(1)], { field: "outcome", value: null }))).toBe("42501");
  });

  it("says nothing changed, with no batch, when every file already has the value", async () => {
    const result = await bulk(ada, [sha(7)], { field: "experiment", value: gels });
    expect(result).toMatchObject({ batchId: null, changed: [], same: 1 });
  });
});

describe("undo_label_batch", () => {
  const undo = (userId: string, batchId: string) =>
    call(userId, "undo_label_batch($1, $2)", [lab, batchId]).then((r) => UndoBatchRow.parse(r));

  it("puts every file back, except one changed since, which keeps its newer label", async () => {
    const before1 = await labelOf(ada, sha(1));
    const before2 = await labelOf(ada, sha(2));
    const result = await bulk(ada, [sha(1), sha(2)], { field: "person", value: null });
    const batch = result.batchId ?? "";
    // Someone changes run 2 after the batch.
    await call(ada, "correct_labels($1, $2, $3::jsonb)", [lab, [sha(2)], JSON.stringify({ field: "instrument", value: "Plate reader" })]);

    expect(await codeOf(undo(ben, batch))).toBe("BL002");
    const undone = await undo(ada, batch);
    expect(undone.undone.map((u) => u.sha256)).toEqual([sha(1)]);
    expect(undone.skipped).toBe(1);
    expect((await labelOf(ada, sha(1))).person?.id).toBe(before1.person?.id);
    const two = await labelOf(ada, sha(2));
    expect(two.person).toBeNull();
    expect(two.instrument).toBe("Plate reader");
    expect(before2.person?.id).toBe(priya);

    // Again: nothing left to undo, the one undone is counted as skipped.
    expect((await undo(ada, batch)).undone).toEqual([]);
  });
});

describe("skip_follow_up", () => {
  it("stops asking, asks again on undo, and leaves an earlier correction undoable", async () => {
    expect((await labelOf(ada, sha(6))).followUp?.question).toBe("Which experiment was this?");
    const corrected = CorrectionRows.parse(
      await call(ada, "(select jsonb_agg(to_jsonb(r)) from correct_label($1, $2, 'Voice note about drug A', null, null, $3, null, '{}') r)", [lab, sha(6), priya]),
    );
    expect(corrected.label.followUp).not.toBeNull();

    const skipped = LabelRow.parse(await call(ben, "skip_follow_up($1, $2, true)", [lab, sha(6)]));
    expect(skipped.followUp).toBeNull();
    expect((await labelOf(ada, sha(6))).followUp).toBeNull();

    // The skip isn't part of the recorded label, so undoing the rename still applies.
    const undone = CorrectionRows.parse(await call(ada, "(select jsonb_agg(to_jsonb(r)) from undo_correction($1) r)", [corrected.correctionId]));
    expect(undone.label.cleanName).toBe("Voice note");
    expect(undone.label.followUp).toBeNull();

    const asked = LabelRow.parse(await call(ada, "skip_follow_up($1, $2, false)", [lab, sha(6)]));
    expect(asked.followUp?.choices).toEqual([{ label: "HeLa drug A", value: hela }]);
  });

  it("refuses a file with no label and a non-member", async () => {
    expect(await codeOf(call(ada, "skip_follow_up($1, $2, true)", [lab, sha(77)]))).toBe("BL001");
    expect(await codeOf(call(cy, "skip_follow_up($1, $2, true)", [lab, sha(6)]))).toBe("42501");
  });
});

describe("link_repeat", () => {
  const link = (userId: string, s: Sha256, repeats: Sha256 | null) => call(userId, "link_repeat($1, $2, $3)", [lab, s, repeats]).then((r) => LabelRow.parse(r));

  it("shows the repeat on both runs, and unlinks", async () => {
    const repeat = await link(ada, sha(2), sha(1));
    expect(repeat.repeatOf).toEqual({ sha256: sha(1), name: "Drug A run 1" });
    await link(ben, sha(3), sha(1));
    expect((await labelOf(ada, sha(1))).repeatedIn.map((r) => r.name)).toEqual(["Drug A run 2", "Drug A run 3"]);

    // Linking again moves the link.
    expect((await link(ada, sha(3), sha(2))).repeatOf?.sha256).toBe(sha(2));
    expect((await labelOf(ada, sha(1))).repeatedIn.map((r) => r.sha256)).toEqual([sha(2)]);
    expect((await labelOf(ada, sha(2))).repeatedIn.map((r) => r.sha256)).toEqual([sha(3)]);

    expect((await link(ada, sha(3), null)).repeatOf).toBeNull();
    expect((await labelOf(ada, sha(2))).repeatedIn).toEqual([]);
  });

  it("refuses a loop, itself, an unnamed file, another lab's file and a non-member", async () => {
    await link(ada, sha(2), sha(1));
    await link(ada, sha(3), sha(2));
    expect(await codeOf(link(ada, sha(1), sha(3)))).toBe("BL812");
    expect(await codeOf(link(ada, sha(1), sha(1)))).toBe("BL812");
    expect(await codeOf(link(ada, sha(1), sha(4)))).toBe("BL811");
    expect(await codeOf(link(ada, sha(1), sha(50)))).toBe("BL811");
    expect(await codeOf(link(cy, sha(1), sha(2)))).toBe("42501");
    await link(ada, sha(3), null);
  });

  it("offers the same experiment's runs first, nearest day first, never itself, a repeat of it or a deleted file", async () => {
    const candidates = async (s: Sha256, q: string) =>
      RepeatCandidates.parse(await call(ada, "(select coalesce(jsonb_agg(to_jsonb(r)), '[]') from repeat_candidates($1, $2, $3, 8) r)", [lab, s, q]));
    // Run 2 repeats run 1, and run 1's experiment is now Gels.
    const forRun1 = await candidates(sha(1), "");
    expect(forRun1.map((c) => c.sha256)).not.toContain(sha(1));
    expect(forRun1.map((c) => c.sha256)).not.toContain(sha(2));
    expect(forRun1.map((c) => c.sha256)).not.toContain(sha(9));
    expect(forRun1.map((c) => c.sha256)).not.toContain(sha(4));
    // Run 1 has no day now, so today stands in: run 3 (Oct 15) before Gel 7 (Sep 1).
    expect(forRun1.slice(0, 2).map((c) => c.name)).toEqual(["Drug A run 3", "Gel 7"]);

    // The pilot (Jun 1) shares its experiment with nothing left, so the nearest day leads.
    expect((await candidates(sha(8), ""))[0]?.name).toBe("Gel 7");
    expect((await candidates(sha(8), "run 3")).map((c) => c.name)).toEqual(["Drug A run 3"]);
  });
});
