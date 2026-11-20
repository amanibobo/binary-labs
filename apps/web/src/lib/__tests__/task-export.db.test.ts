import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { LabId, PersonId, RunId, Sha256 } from "../ids";
import type { RunDb } from "../run-record-store";
import { RunTaskJson, TaskManifestJson } from "../task-export";
import type { GateAnswer } from "../task-folder-gate";
import type { Claim, FolderStore } from "../task-folder-store";

// De-identification and the task folder against the real migrations (0034 and 0039): the
// second scientist's task, the build, the download, and every way the database refuses.
// The gate is the sharing slice's; here a grant is made the way its function will make one,
// by the owner writing an 'export.allowed' row to run_log.

vi.mock("server-only", () => ({}));

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ada = "00000000-0000-4000-8000-0000000e0001";
const ben = "00000000-0000-4000-8000-0000000e0002";
const cy = "00000000-0000-4000-8000-0000000e0003";
const owner = (sql: string, params: unknown[] = []) => db.query(sql, params);
const count = async (sql: string, params: unknown[] = []) => Number((await owner(`select count(*) as n from ${sql}`, params)).rows[0]?.n);
const shaOf = (bytes: Uint8Array) => Sha256.parse(createHash("sha256").update(bytes).digest("hex"));

function memberDb(userId: string): RunDb {
  return {
    rpc: async (fn, args) => {
      if (!/^[a-z_]+$/.test(fn) || !Object.keys(args).every((k) => /^[a-z_0-9]+$/.test(k))) throw new Error(`not a function call: ${fn}`);
      const names = Object.keys(args);
      const call = `${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
        const proc = z
          .object({ proretset: z.boolean(), names: z.array(z.string()), types: z.array(z.string()) })
          .parse((await db.query("select proretset, proargnames as names, proargtypes::regtype[]::text[] as types from pg_proc where proname = $1", [fn])).rows[0]);
        // PostgREST sends JSON and the database reads each argument as its declared type.
        const isJson = (name: string) => proc.types[proc.names.indexOf(name)] === "jsonb";
        const res = await db.query(
          proc.proretset ? `select coalesce(jsonb_agg(r), '[]'::jsonb) as v from ${call} r` : `select ${call} as v`,
          names.map((k) => (isJson(k) ? JSON.stringify(args[k]) : args[k])),
        );
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
const codeOf = async (call: PromiseLike<{ error: { code?: string } | null }>) => (await call).error?.code ?? "ok";

// The store as a map, with the path each object was put from read at put time.
function memoryStore(): FolderStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    read: async (key) => {
      const bytes = objects.get(key);
      if (bytes === undefined) throw new Error(`no object at ${key}`);
      return (async function* () {
        yield bytes.subarray(0, Math.ceil(bytes.length / 2));
        yield bytes.subarray(Math.ceil(bytes.length / 2));
      })();
    },
    put: async (key, file) => {
      objects.set(key, await readFile(file.path));
    },
    remove: async (key) => {
      objects.delete(key);
    },
  };
}

// A zip's entries, read from its central directory.
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const total = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < total; i++) {
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + packed);
    const bytes = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(bytes.length).toBe(size);
    out.set(name, bytes);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return out;
}

const CSV = new TextEncoder().encode("well,od600,operator\nA1,0.42,Priya Nair\nA2,0.44,PN-042\nA3,0.40,priya.n@okafor.example\nA4,0.39,Project Nightjar\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 1, 2, 3, 255, 254]);
const NOTES = new TextEncoder().encode("Jordan Morales said the lysate looked cloudy.\n");
// Every spelling that must not be in a folder. "ada" and "ben" are the members' emails.
const NAMES = ["priya", "nair", "jordan", "morales", "okafor", "nightjar", "pn-042", "okafor.example", "ada@", "ben@"];

let lab: LabId;
let otherLab: LabId;
let demoLab: LabId;
let priya: PersonId;
let jordan: PersonId;
let ade: PersonId;
let outsider: PersonId;
let source: string;
let experiment: string;
let protocolVersion: string;
const originals = memoryStore();

async function addFile(labId: LabId, sourceId: string, bytes: Uint8Array, name: string, kind: string, mime: string): Promise<Sha256> {
  const sha = shaOf(bytes);
  await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, $2, $3, $4) on conflict do nothing", [sha, bytes.length, mime, kind]);
  await owner(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, $3, '/Lab/Gels/' || $3, $3, $4, now(), 'r', $5, 'indexed')`,
    [labId, sourceId, name, bytes.length, sha],
  );
  await owner("update file_versions set kept_at = now() where lab_id = $1 and sha256 = $2", [labId, sha]);
  originals.objects.set(`${labId}/files/${sha}`, Buffer.from(bytes));
  return sha;
}

type RunSeed = { attested?: boolean; share?: boolean; labId?: LabId; user?: string; files?: Sha256[] };
let csv: Sha256;
let png: Sha256;
let notes: Sha256;

// A failed run with a confirmed cause, as the failure and evidence slices will leave it; the
// owner writes the columns their functions will.
async function seedRun(seed: RunSeed = {}): Promise<RunId> {
  const labId = seed.labId ?? lab;
  const made = await memberDb(seed.user ?? ada).rpc("create_run", { p_lab_id: labId, p_shas: seed.files ?? [csv, png, notes], p_fields: { title: "Priya Nair BM3 expression, first try", status: "failed", started_on: "2026-10-14" } });
  if (made.error !== null) throw new Error(made.error.message);
  const id = RunId.parse(z.object({ id: z.string() }).parse(made.data).id);
  if (labId !== lab) return id;
  await owner(
    `update runs set person_id = $2, experiment_id = $3, suspected_cause = 'Priya thought the IPTG was old.',
       confirmed_cause = 'The IPTG stock had gone off; Jordan Morales repeated it with fresh IPTG and it expressed.',
       confirmed_by = $4, confirm_method = 'repeat', confirm_note = 'Repeat by JM on the Okafor Lab shaker.', confirmed_at = now(),
       confirm_recorded_by = $5, confirmer_attested_at = $6,
       aim = 'Express BM3 for Project Nightjar.', expected_seen = 'A band at 119 kDa; Priya saw none.',
       how_found = 'Jordan re-ran it.', what_changed = 'Fresh IPTG.', fix_worked = 'yes', who_else = 'Ade Okafor',
       planned_version_id = $7, as_run_body = 'Induced at OD 0.9 (PN was late).', as_run_at = now(), as_run_by = $5
     where id = $1`,
    [id, priya, experiment, jordan, ada, seed.attested === false ? null : new Date().toISOString(), protocolVersion],
  );
  if (seed.share !== false) await owner("update runs set share = true where id = $1", [id]);
  return id;
}

const task = { question: "Why did Priya Nair's BM3 expression give no band?", rubric: [{ criterion: "Names the IPTG stock as the cause", points: 6 }, { criterion: "Says how Jordan's repeat showed it", points: 4 }], notes: "Agree. Ade Okafor saw the repeat gel too.", agrees: true };
const saveTask = (userId: string, runId: RunId, reviewer: PersonId | null, over: Record<string, unknown> = {}) =>
  memberDb(userId).rpc("save_run_task", { p_run_id: runId, p_question: task.question, p_rubric: task.rubric, p_reviewer_id: reviewer, p_notes: task.notes, p_agrees: task.agrees, ...over });

// The gate, as the sharing slice's function will answer when both switches are on.
const grants: Claim = async (runId) => {
  const row = await owner("insert into run_log (lab_id, run_id, via, action, after) select lab_id, id, 'person', 'export.allowed', '{}' from runs where id = $1 returning id", [runId]);
  return { kind: "granted", grant: { runId, logId: Number(row.rows[0]?.id) } } satisfies GateAnswer;
};
const refuses: Claim = async () => ({ kind: "blocked", reasons: ["gate_not_built"] });
const blockedLog = async (runId: RunId) =>
  z.array(z.object({ after: z.object({ reasons: z.array(z.string()), stage: z.string() }), actor: z.string().nullable() })).parse((await owner("select after, actor from run_log where run_id = $1 and action = 'export.blocked' order by id", [runId])).rows);

beforeAll(async () => {
  await db.connect();
  await owner("insert into auth.users (id, email) values ($1, 'ada@export.test'), ($2, 'ben@export.test'), ($3, 'cy@export.test')", [ada, ben, cy]);
  const made = async (userId: string, name: string) => LabId.parse(CreateLabResult.parse((await memberDb(userId).rpc("create_lab", { p_name: name })).data));
  lab = await made(ada, "Okafor Lab");
  otherLab = await made(cy, "Other export lab");
  demoLab = await made(cy, "Demo export lab");
  await owner("update labs set plan = 'demo', sharing_agreed_at = now(), sharing_agreement = 'draft-1' where id = $1", [demoLab]);
  await owner("update labs set sharing_agreed_at = now(), sharing_agreement = 'draft-1', sharing_agreed_by = $2 where id = $1", [lab, ada]);
  await owner("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, ben]);
  const person = async (labId: LabId, name: string, aliases: string[], userId: string | null = null) =>
    PersonId.parse((await owner("insert into people (lab_id, display_name, aliases, member_user_id) values ($1, $2, $3, $4) returning id", [labId, name, aliases, userId])).rows[0]?.id);
  priya = await person(lab, "Priya Nair", ["PN"]);
  jordan = await person(lab, "Jordan Morales", ["JM"], ben);
  ade = await person(lab, "Ade Okafor", ["AO"], ada);
  outsider = await person(otherLab, "Sam Other", []);
  source = (await owner("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/e') returning id", [lab])).rows[0]?.id;
  experiment = (await owner("insert into experiments (lab_id, name) values ($1, 'P450 BM3 for Priya') returning id", [lab])).rows[0]?.id;
  csv = await addFile(lab, source, CSV, "Priya_Nair_plate7.csv", "spreadsheet", "text/csv");
  png = await addFile(lab, source, PNG, "PN-042 gel.png", "image", "image/png");
  notes = await addFile(lab, source, NOTES, "notes_jordan.txt", "text", "text/plain");
  const protocol = await memberDb(ada).rpc("create_protocol", { p_lab_id: lab, p_kind: "protocol", p_title: "BM3 expression (Okafor Lab)", p_body: "Induce at OD 0.6. Ask Priya for IPTG." });
  protocolVersion = z.array(z.object({ version_id: z.string() })).parse(protocol.data)[0]?.version_id ?? "";
  await owner("insert into export_exclusions (lab_id, kind, value) values ($1, 'text', 'Project Nightjar')", [lab]);
  const theirSource = (await owner("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/d') returning id", [demoLab])).rows[0]?.id;
  await addFile(demoLab, theirSource, new TextEncoder().encode("demo\n"), "demo.csv", "spreadsheet", "text/csv");
});

afterAll(async () => {
  await db.end();
});

describe("the second scientist's task", () => {
  it("is written only once the cause is confirmed and the confirmer has said so", async () => {
    const bare = RunId.parse(z.object({ id: z.string() }).parse((await memberDb(ada).rpc("create_run", { p_lab_id: lab, p_shas: [csv], p_fields: { title: "Bare", status: "failed" } })).data).id);
    expect(await codeOf(saveTask(ben, bare, jordan))).toBe("BL962");
    const unattested = await seedRun({ attested: false });
    expect(await codeOf(saveTask(ben, unattested, jordan))).toBe("BL962");
    expect(await count("run_rubrics where run_id = any ($1)", [[bare, unattested]])).toBe(0);
  });

  it("needs a reviewer from the lab's people who isn't the person who ran it", async () => {
    const run = await seedRun();
    expect(await codeOf(saveTask(ben, run, priya))).toBe("BL961");
    expect(await codeOf(saveTask(ben, run, outsider))).toBe("BL961");
    expect(await codeOf(saveTask(ben, run, null))).toBe("BL961");
    expect(await codeOf(saveTask(cy, run, jordan))).toBe("42501");
    expect(await count("run_rubrics where run_id = $1", [run])).toBe(0);
  });

  it.each([
    ["no criteria", []],
    ["a criterion with no words", [{ criterion: " ", points: 2 }]],
    ["points that aren't a whole number from 1 to 10", [{ criterion: "x", points: 11 }]],
    ["points as text", [{ criterion: "x", points: "many" }]],
    ["an extra key", [{ criterion: "x", points: 2, name: "Priya" }]],
    ["not a list", { criterion: "x", points: 2 }],
  ])("refuses a rubric with %s", async (_what, rubric) => {
    const run = await seedRun();
    expect(await codeOf(saveTask(ben, run, jordan, { p_rubric: rubric }))).toBe("BL963");
  });

  it("saves the question, rubric and review, and saving again replaces that reviewer's notes", async () => {
    const run = await seedRun();
    const before = RunTaskJson.parse((await memberDb(ben).rpc("run_task_json", { p_run_id: run })).data);
    expect(before).toMatchObject({ question: null, rubric: [], review: null, gaps: ["no_task", "no_review"], blocks: [], demo: false, canExclude: false });
    const saved = RunTaskJson.parse((await saveTask(ben, run, jordan)).data);
    expect(saved).toMatchObject({ question: task.question, rubric: task.rubric, review: { reviewer: { id: jordan, name: "Jordan Morales" }, notes: task.notes, agrees: true }, gaps: [] });
    await saveTask(ben, run, jordan, { p_notes: "On reflection, not sure.", p_agrees: null });
    expect(await count("run_reviews where run_id = $1", [run])).toBe(1);
    expect(RunTaskJson.parse((await memberDb(ada).rpc("run_task_json", { p_run_id: run })).data).review).toMatchObject({ notes: "On reflection, not sure.", agrees: null });
    // Writing the task isn't a change to the run, so what was agreed to share still stands.
    expect((await owner("select share from runs where id = $1", [run])).rows[0]?.share).toBe(true);
  });

  it("is nobody else's to read", async () => {
    const run = await seedRun();
    await saveTask(ben, run, jordan);
    expect((await memberDb(cy).rpc("run_task_json", { p_run_id: run })).data).toBeNull();
    expect(await codeOf(memberDb(cy).rpc("task_export_source", { p_run_id: run }))).toBe("42501");
    expect((await memberDb(cy).rpc("task_export_file", { p_run_id: run, p_export_id: "00000000-0000-4000-8000-000000000000" })).data).toEqual([]);
    expect(await codeOf(memberDb(cy).rpc("build_task_export", { p_run_id: run, p_export_id: "00000000-0000-4000-8000-000000000000", p_grant_id: 1, p_purpose: "x", p_manifest: {} }))).toBe("42501");
  });
});

describe("what a lab leaves out", () => {
  it("is an admin's to change, and only from the kinds a lab can leave out", async () => {
    const set = (userId: string, kind: string, value: string, on = true) => memberDb(userId).rpc("set_export_exclusion", { p_lab_id: lab, p_kind: kind, p_value: value, p_on: on });
    expect(await codeOf(set(ben, "field", "confirm_note"))).toBe("42501");
    expect(await codeOf(set(cy, "field", "confirm_note"))).toBe("42501");
    expect(await codeOf(set(ada, "tag", "x"))).toBe("BL966");
    expect(await codeOf(set(ada, "text", "  "))).toBe("BL966");
    expect(await codeOf(set(ada, "experiment", "00000000-0000-4000-8000-000000000000"))).toBe("BL966");
    expect((await set(ada, "field", "confirm_note")).data).toEqual([{ kind: "field", value: "confirm_note" }, { kind: "text", value: "Project Nightjar" }]);
    expect((await set(ada, "field", "confirm_note", false)).data).toEqual([{ kind: "text", value: "Project Nightjar" }]);
  });

  it("an experiment left out keeps its runs in the lab", async () => {
    const run = await seedRun();
    await saveTask(ben, run, jordan);
    await memberDb(ada).rpc("set_export_exclusion", { p_lab_id: lab, p_kind: "experiment", p_value: experiment, p_on: true });
    const store = await import("../task-folder-store");
    const built = await store.buildTask({ db: memberDb(ada), store: originals, claim: grants }, lab, run);
    expect(built).toEqual({ kind: "ok", value: { kind: "blocked", reasons: ["excluded_experiment"] } });
    await memberDb(ada).rpc("set_export_exclusion", { p_lab_id: lab, p_kind: "experiment", p_value: experiment, p_on: false });
  });
});

describe("building the folder", () => {
  it("writes every part, with no name in any of them, and records it", async () => {
    const store = await import("../task-folder-store");
    const run = await seedRun();
    await saveTask(ben, run, ade);
    const before = originals.objects.size;
    const built = await store.buildTask({ db: memberDb(ada), store: originals, claim: grants }, lab, run);
    if (built.kind !== "ok" || built.value.kind !== "built") throw new Error(`not built: ${JSON.stringify(built)}`);
    const id = built.value.id;
    const prefix = `${lab}/exports/${id}`;
    expect(originals.objects.size).toBe(before + 2);

    const zip = originals.objects.get(`${prefix}/task.zip`);
    if (zip === undefined) throw new Error("no zip in the store");
    const files = unzip(zip);
    const root = `task-${id}/`;
    expect([...files.keys()].map((k) => k.slice(root.length)).sort()).toEqual([
      "answer_key.md",
      "context.md",
      "evidence/01-Person A_plate7.csv",
      "evidence/02-Sample 1 gel.png",
      "evidence/03-notes_Person B.txt",
      "manifest.json",
      "protocol_as_run.md",
      "protocol_as_written.md",
      "provenance.json",
      "question.md",
      "review_notes.md",
      "rubric.json",
    ]);
    const text = (name: string) => (files.get(root + name) ?? Buffer.alloc(0)).toString("utf8");

    // No name, initials-with-number, email, lab name or marked phrase anywhere, the file
    // names included. The image is the one thing nobody can look inside.
    for (const [name, bytes] of files) {
      const haystack = `${name}\n${name.endsWith(".png") ? "" : bytes.toString("utf8")}`.toLowerCase();
      for (const trace of NAMES) expect(haystack, `${trace} in ${name}`).not.toContain(trace);
    }

    expect(text("question.md")).toBe("# Question\n\nWhy did Person A's BM3 expression give no band?\n");
    expect(text("context.md")).toContain("Run: Person A BM3 expression, first try");
    expect(text("context.md")).toContain("Run by: Person A");
    expect(text("context.md")).toContain("Express BM3 for [removed].");
    expect(text("context.md")).not.toContain("IPTG");
    expect(text("answer_key.md")).toContain("The IPTG stock had gone off; Person B repeated it with fresh IPTG and it expressed.");
    expect(text("answer_key.md")).toContain("Method: A repeat\nConfirmed by: Person B, on ");
    expect(text("answer_key.md")).toContain("Note: Repeat by Person B on the [removed] shaker.");
    expect(text("protocol_as_run.md")).toBe("# Protocol as run\n\nInduced at OD 0.9 (Person A was late).\n");
    expect(text("protocol_as_written.md")).toContain("Induce at OD 0.6. Ask Person A for IPTG.");
    expect(JSON.parse(text("rubric.json"))).toEqual({ total_points: 10, criteria: [{ criterion: "Names the IPTG stock as the cause", points: 6 }, { criterion: "Says how Person B's repeat showed it", points: 4 }] });
    expect(text("review_notes.md")).toContain("## Person C, ");
    expect(text("review_notes.md")).toContain("Agrees with the confirmed cause: Yes\n\nAgree. Person C saw the repeat gel too.");
    expect(text("evidence/01-Person A_plate7.csv")).toBe("well,od600,operator\nA1,0.42,Person A\nA2,0.44,Sample 1\nA3,0.40,Email 1\nA4,0.39,[removed]\n");
    expect(files.get(`${root}evidence/02-Sample 1 gel.png`)?.equals(Buffer.from(PNG))).toBe(true);

    const provenance = z
      .object({
        run: z.object({ id: z.string(), run_by: z.string(), status_set_by: z.string().nullable() }),
        cause: z.object({ confirmed_by: z.string(), method: z.string(), confirmed_at: z.string(), typed_in_by: z.string(), confirmer_said_so_at: z.string(), others_who_could_confirm: z.string() }),
        task: z.object({ question_and_rubric_by: z.string(), written_at: z.string(), reviews: z.array(z.object({ reviewer: z.string(), typed_in_by: z.string(), reviewed_at: z.string(), agrees: z.boolean() })) }),
        sharing: z.object({ lab_agreement: z.string(), lab_agreed_by: z.string() }),
        history: z.array(z.object({ action: z.string(), by: z.string().nullable(), at: z.string() })),
      })
      .parse(JSON.parse(text("provenance.json")));
    expect(provenance).toMatchObject({
      run: { id: run, run_by: "Person A", status_set_by: "Person C" },
      cause: { confirmed_by: "Person B", method: "repeat", typed_in_by: "Person C", others_who_could_confirm: "Person C" },
      task: { question_and_rubric_by: "Person B", reviews: [{ reviewer: "Person C", typed_in_by: "Person B", agrees: true }] },
      sharing: { lab_agreement: "draft-1", lab_agreed_by: "Person C" },
    });
    expect(provenance.history.map((h) => h.action)).toEqual(expect.arrayContaining(["run.create", "run.files", "run.edit", "run.share"]));

    const manifest = TaskManifestJson.parse(JSON.parse(text("manifest.json")));
    expect(manifest).toMatchObject({ format: "binary-task/1", taskId: id, runId: run, sample: false, leftOut: [] });
    expect(manifest.parts.map((p) => p.path)).toEqual(["question.md", "context.md", "protocol_as_run.md", "protocol_as_written.md", "answer_key.md", "rubric.json", "review_notes.md", "provenance.json"]);
    for (const part of [...manifest.parts, ...manifest.evidence]) expect(shaOf(files.get(root + part.path) ?? Buffer.alloc(0)), part.path).toBe(part.sha256);
    expect(manifest.evidence.map((e) => [e.treatment, e.sourceSha256])).toEqual([["scrubbed", csv], ["as_is", png], ["scrubbed", notes]]);
    expect(manifest.deidentification).toMatchObject({ people: 3, includedAsIs: ["evidence/02-Sample 1 gel.png"], excluded: [] });

    const row = (await owner("select lab_id, run_id, storage_prefix, manifest, built_by, withdrawn_at, purpose from task_exports where id = $1", [id])).rows[0];
    expect(row).toMatchObject({ lab_id: lab, run_id: run, storage_prefix: prefix, built_by: ada, withdrawn_at: null, purpose: "task_folder" });
    expect(row?.manifest?.zip).toEqual({ bytes: zip.length, sha256: shaOf(zip) });
    expect(JSON.parse((originals.objects.get(`${prefix}/manifest.json`) ?? Buffer.alloc(0)).toString("utf8"))).toEqual(row?.manifest);
    expect(await blockedLog(run)).toEqual([]);
    expect(RunTaskJson.parse((await memberDb(ben).rpc("run_task_json", { p_run_id: run })).data).exports).toMatchObject([{ id, withdrawnAt: null, hasFiles: true, files: 3, bytes: zip.length }]);
  });

  it("leaves out the fields and the kinds of file the lab marked, and says so", async () => {
    const store = await import("../task-folder-store");
    const run = await seedRun();
    await saveTask(ben, run, ade);
    for (const value of ["evidence.image", "suspected_cause", "protocol_as_written", "debrief"]) await memberDb(ada).rpc("set_export_exclusion", { p_lab_id: lab, p_kind: "field", p_value: value, p_on: true });
    await memberDb(ada).rpc("set_export_exclusion", { p_lab_id: lab, p_kind: "folder", p_value: "/Lab/Gels/notes_jordan.txt", p_on: true });
    try {
      const preview = await store.previewTask(memberDb(ben), originals, lab, run);
      if (preview.kind !== "ok") throw new Error("no preview");
      expect(preview.value.evidence.map((e) => [e.path, e.was, e.treatment])).toEqual([["evidence/01-Person A_plate7.csv", "Priya_Nair_plate7.csv", "scrubbed"]]);
      expect(preview.value.leftOut).toEqual([{ was: "PN-042 gel.png", kind: "image", reason: "kind_excluded" }, { was: "notes_jordan.txt", kind: "text", reason: "folder_excluded" }]);
      expect(preview.value.parts.map((p) => p.path)).not.toContain("protocol_as_written.md");
      const all = preview.value.parts.map((p) => p.text).join("\n");
      for (const gone of ["IPTG was old", "Fresh IPTG", "119 kDa"]) expect(all).not.toContain(gone);
      expect(preview.value.excluded).toEqual(["debrief", "evidence.image", "protocol_as_written", "suspected_cause"]);
      expect(preview.value.reasons).toEqual([]);

      const built = await store.buildTask({ db: memberDb(ada), store: originals, claim: grants }, lab, run);
      if (built.kind !== "ok" || built.value.kind !== "built") throw new Error("not built");
      const manifest = TaskManifestJson.parse((await owner("select manifest from task_exports where id = $1", [built.value.id])).rows[0]?.manifest);
      expect(manifest.leftOut).toEqual([{ kind: "image", role: "evidence", reason: "kind_excluded" }, { kind: "text", role: "evidence", reason: "folder_excluded" }]);
      expect(manifest.deidentification.includedAsIs).toEqual([]);
    } finally {
      await owner("delete from export_exclusions where lab_id = $1 and kind in ('field', 'folder')", [lab]);
    }
  });

  it("builds nothing when a part can't be shown to be free of names", async () => {
    const store = await import("../task-folder-store");
    const run = await seedRun();
    await saveTask(ben, run, ade);
    // Someone whose name is a word the folder itself uses: the check can't tell them apart.
    await owner("insert into people (lab_id, display_name) values ($1, 'Evidence Okoro')", [lab]);
    try {
      const built = await store.buildTask({ db: memberDb(ada), store: originals, claim: grants }, lab, run);
      expect(built).toMatchObject({ kind: "ok", value: { kind: "leaks" } });
      expect(built.kind === "ok" && built.value.kind === "leaks" ? built.value.paths : []).toContain("context.md");
      expect(await count("task_exports where run_id = $1", [run])).toBe(0);
    } finally {
      await owner("delete from people where lab_id = $1 and display_name = 'Evidence Okoro'", [lab]);
    }
  });

  it("a stored file that isn't the file the run names stops the build", async () => {
    const store = await import("../task-folder-store");
    const run = await seedRun({ files: [png] });
    await saveTask(ben, run, ade);
    const key = `${lab}/files/${png}`;
    originals.objects.set(key, Buffer.from([1, 2, 3]));
    try {
      await expect(store.buildTask({ db: memberDb(ada), store: originals, claim: grants }, lab, run)).rejects.toThrow("doesn't match");
      expect(await count("task_exports where run_id = $1", [run])).toBe(0);
    } finally {
      originals.objects.set(key, Buffer.from(PNG));
    }
  });
});

describe("the database refuses, and writes it down", () => {
  const attempt = async (run: RunId, claim: Claim = grants, userId = ada, labId = lab) => {
    const store = await import("../task-folder-store");
    const before = [...originals.objects.keys()].filter((k) => k.includes("/exports/")).length;
    const built = await store.buildTask({ db: memberDb(userId), store: originals, claim }, labId, run);
    expect([...originals.objects.keys()].filter((k) => k.includes("/exports/")).length, "nothing is left in the store").toBe(before);
    expect(await count("task_exports where run_id = $1", [run])).toBe(0);
    return built.kind === "ok" && built.value.kind === "blocked" ? built.value.reasons : built;
  };

  it("a run whose own switch is off", async () => {
    const run = await seedRun({ share: false });
    await saveTask(ben, run, ade);
    expect(await attempt(run)).toEqual(["run_off"]);
    expect(await blockedLog(run)).toEqual([{ after: { reasons: ["run_off"], stage: "build" }, actor: ada }]);
    expect(await count("audit_log where lab_id = $1 and action = 'run.export_blocked' and target = $2", [lab, run])).toBe(1);
  });

  it("a lab that hasn't agreed", async () => {
    const run = await seedRun();
    await saveTask(ben, run, ade);
    await owner("update labs set sharing_agreed_at = null, sharing_agreement = null where id = $1", [lab]);
    try {
      expect(await attempt(run)).toEqual(["lab_off"]);
      expect((await blockedLog(run)).map((l) => l.after.reasons)).toEqual([["lab_off"]]);
    } finally {
      await owner("update labs set sharing_agreed_at = now(), sharing_agreement = 'draft-1' where id = $1", [lab]);
    }
  });

  it("a cause the confirmer hasn't attested", async () => {
    const run = await seedRun();
    await saveTask(ben, run, ade);
    await owner("update runs set confirmer_attested_at = null where id = $1", [run]);
    await owner("update runs set share = true where id = $1", [run]);
    expect(await attempt(run)).toEqual(["not_attested"]);
    expect((await blockedLog(run)).map((l) => l.after.reasons)).toEqual([["not_attested"]]);
  });

  it("a demo lab, whose data is made up", async () => {
    const run = await seedRun({ labId: demoLab, user: cy, files: [shaOf(new TextEncoder().encode("demo\n"))] });
    await owner("update runs set share = true where id = $1", [run]);
    const reasons = await attempt(run, grants, cy, demoLab);
    expect(reasons).toEqual(expect.arrayContaining(["demo_lab", "no_confirmed_cause"]));
    expect((await blockedLog(run))[0]?.after.reasons).toContain("demo_lab");
  });

  it("a run with no task written, no review or no protocol", async () => {
    const run = await seedRun();
    await owner("update runs set planned_version_id = null, as_run_body = null, as_run_at = null where id = $1", [run]);
    await owner("update runs set share = true where id = $1", [run]);
    expect(await attempt(run)).toEqual(["no_task", "no_review", "no_protocol"]);
  });

  it("a run one of whose files Binary hasn't kept", async () => {
    const run = await seedRun();
    await saveTask(ben, run, ade);
    await owner("update file_versions set kept_at = null where lab_id = $1 and sha256 = $2", [lab, notes]);
    try {
      expect(await attempt(run)).toEqual(["file_not_kept"]);
    } finally {
      await owner("update file_versions set kept_at = now() where lab_id = $1 and sha256 = $2", [lab, notes]);
    }
  });

  it("a gate that says no: the attempt is still written down, with the database's reasons", async () => {
    const shared = await seedRun();
    await saveTask(ben, shared, ade);
    expect(await attempt(shared, refuses)).toEqual(["gate_not_built"]);
    expect((await blockedLog(shared)).map((l) => l.after.reasons)).toEqual([["no_grant"]]);
    const off = await seedRun({ share: false });
    await saveTask(ben, off, ade);
    expect(await attempt(off, refuses)).toEqual(["run_off"]);
  });

  it("a grant used before, another run's grant, and one that isn't a grant", async () => {
    const run = await seedRun();
    await saveTask(ben, run, ade);
    const other = await seedRun();
    const record = (grant: number | null, id: string) => memberDb(ada).rpc("build_task_export", { p_run_id: run, p_export_id: id, p_grant_id: grant, p_purpose: "task_folder", p_manifest: {} });
    const granted = await grants(run, "x");
    if (granted.kind !== "granted") throw new Error("no grant");
    const first = "10000000-0000-4000-8000-000000000001";
    expect((await record(granted.grant.logId, first)).data).toMatchObject({ kind: "built", id: first, prefix: `${lab}/exports/${first}` });
    expect((await record(granted.grant.logId, "10000000-0000-4000-8000-000000000002")).data).toEqual({ kind: "blocked", reasons: ["no_grant"] });
    const theirs = await grants(other, "x");
    if (theirs.kind !== "granted") throw new Error("no grant");
    expect((await record(theirs.grant.logId, "10000000-0000-4000-8000-000000000003")).data).toEqual({ kind: "blocked", reasons: ["no_grant"] });
    const edit = Number((await owner("select id from run_log where run_id = $1 and action = 'run.create'", [run])).rows[0]?.id);
    expect((await record(edit, "10000000-0000-4000-8000-000000000004")).data).toEqual({ kind: "blocked", reasons: ["no_grant"] });
    expect((await record(null, "10000000-0000-4000-8000-000000000005")).data).toEqual({ kind: "blocked", reasons: ["no_grant"] });
    expect(await count("task_exports where run_id = $1", [run])).toBe(1);
    expect((await blockedLog(run)).length).toBe(4);
  });
});

describe("downloading", () => {
  it("asks the gate again, sends the stored bytes, and refuses once sharing has gone off", async () => {
    const store = await import("../task-folder-store");
    const run = await seedRun();
    await saveTask(ben, run, ade);
    const deps = { db: memberDb(ben), store: originals, claim: grants };
    const built = await store.buildTask(deps, lab, run);
    if (built.kind !== "ok" || built.value.kind !== "built") throw new Error("not built");
    const id = built.value.id;
    const key = `${lab}/exports/${id}/task.zip`;
    const zip = originals.objects.get(key);
    if (zip === undefined) throw new Error("no zip");

    const opened = await store.openTask(deps, run, id);
    if (opened.kind !== "ok") throw new Error(`not opened: ${opened.kind}`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of opened.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(zip)).toBe(true);
    expect(opened).toMatchObject({ bytes: zip.length, name: `task-${id}.zip` });

    expect(await store.openTask({ ...deps, claim: refuses }, run, id)).toEqual({ kind: "blocked", reasons: ["gate_not_built"] });
    expect(await store.openTask({ ...deps, db: memberDb(cy) }, run, id)).toEqual({ kind: "missing" });
    expect(await store.openTask(deps, run, "20000000-0000-4000-8000-000000000001")).toEqual({ kind: "missing" });

    originals.objects.set(key, Buffer.concat([zip, Buffer.from([0])]));
    expect(await store.openTask(deps, run, id)).toEqual({ kind: "mismatch" });
    originals.objects.set(key, zip);

    // Any change to a shared run turns its sharing off, which withdraws the folder (0034).
    await memberDb(ada).rpc("edit_run", { p_run_id: run, p_fields: { title: "Renamed after sharing" } });
    expect(await store.openTask(deps, run, id)).toEqual({ kind: "withdrawn" });

    // Its files leave the store the next time the task is read, and only then.
    expect(await codeOf(memberDb(cy).rpc("forget_task_export_files", { p_run_id: run, p_export_id: id }))).toBe("42501");
    const task = await store.loadRunTask(memberDb(ben), run);
    if (task === null) throw new Error("no task");
    expect(task.exports).toMatchObject([{ id, hasFiles: true }]);
    expect(task.blocks).toEqual(["run_off"]);
    const after = await store.removeWithdrawn(memberDb(ben), originals, task);
    expect(after.exports).toMatchObject([{ id, hasFiles: false }]);
    expect([...originals.objects.keys()].filter((k) => k.includes(id))).toEqual([]);
    expect((await owner("select storage_prefix from task_exports where id = $1", [id])).rows[0]?.storage_prefix).toBeNull();
    expect(await store.removeWithdrawn(memberDb(ben), originals, after)).toEqual(after);
    expect(await store.openTask(deps, run, id)).toEqual({ kind: "withdrawn" });
  });

  it("a folder that still stands keeps its files", async () => {
    const store = await import("../task-folder-store");
    const run = await seedRun();
    await saveTask(ben, run, ade);
    const built = await store.buildTask({ db: memberDb(ada), store: originals, claim: grants }, lab, run);
    if (built.kind !== "ok" || built.value.kind !== "built") throw new Error("not built");
    expect(await codeOf(memberDb(ada).rpc("forget_task_export_files", { p_run_id: run, p_export_id: built.value.id }))).toBe("BL965");
    expect(await codeOf(memberDb(ada).rpc("forget_task_export_files", { p_run_id: run, p_export_id: "20000000-0000-4000-8000-000000000002" }))).toBe("BL964");
    expect((await owner("select storage_prefix from task_exports where id = $1", [built.value.id])).rows[0]?.storage_prefix).not.toBeNull();
  });
});

describe("who may call what", () => {
  it("the readiness check is the owner's, and nobody signed out gets anything", async () => {
    expect(await codeOf(memberDb(ada).rpc("task_export_gaps", { p_run_id: "00000000-0000-4000-8000-000000000000" }))).toBe("42501");
    const fns = z.array(z.object({ name: z.string(), anon: z.boolean(), member: z.boolean() })).parse(
      (
        await owner(
          `select p.proname as name, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as member
           from pg_proc p where p.proname in ('task_export_gaps', 'run_task_json', 'save_run_task', 'task_export_source', 'build_task_export', 'task_export_file', 'forget_task_export_files', 'set_export_exclusion')
           order by 1`,
        )
      ).rows,
    );
    expect(fns.filter((f) => f.anon)).toEqual([]);
    expect(fns.filter((f) => !f.member).map((f) => f.name)).toEqual(["task_export_gaps"]);
    expect(fns.length).toBe(8);
  });
});
