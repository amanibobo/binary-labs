import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sharingLogLine } from "@/components/runs/api/sharing";
import { CreateLabResult } from "../domain";
import { askExportGate } from "../export-gate";
import { LabId, RunId, Sha256 } from "../ids";
import type { RunDb } from "../run-record-store";
import { loadLabSharing, loadRunSharing, loadSharingLog, setLabShare, setRunShare, sharingFailure } from "../run-sharing-store";

// Sharing and the export gate (0037) against the real migrations, through the routes' core.
// The stand-in calls each database function the way supabase-js does (by name, named
// arguments, as the member under RLS). The cast: Ada is the lab's admin, Ben a member who ran
// the run, Flo a member who didn't, Cy another lab's admin, Dee in no lab, and the worker
// (the owner's connection, which skips row security).

vi.mock("server-only", () => ({}));

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ada = "00000000-0000-4000-8000-0000000f3001";
const ben = "00000000-0000-4000-8000-0000000f3002";
const flo = "00000000-0000-4000-8000-0000000f3003";
const cy = "00000000-0000-4000-8000-0000000f3004";
const dee = "00000000-0000-4000-8000-0000000f3005";
const sha = (n: number) => Sha256.parse(`c${n.toString(16).padStart(63, "0")}`);
const V1 = "draft-1";

function memberDb(userId: string | null, role: "authenticated" | "anon" = "authenticated"): RunDb {
  return {
    rpc: async (fn, args) => {
      if (!/^[a-z_]+$/.test(fn) || !Object.keys(args).every((k) => /^[a-z_0-9]+$/.test(k))) throw new Error(`not a function call: ${fn}`);
      const call = `${fn}(${Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
      await db.query("begin");
      try {
        await db.query(`set local role ${role}`);
        await db.query("select set_config('request.jwt.claims', $1, true)", [userId === null ? "" : JSON.stringify({ sub: userId })]);
        const set = z.object({ proretset: z.boolean() }).parse((await db.query("select proretset from pg_proc where proname = $1", [fn])).rows[0]).proretset;
        const res = await db.query(set ? `select coalesce(jsonb_agg(r), '[]'::jsonb) as v from ${call} r` : `select ${call} as v`, Object.values(args));
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

const owner = (sql: string, params: unknown[] = []) => db.query(sql, params);
const count = async (sql: string, params: unknown[] = []) => Number((await owner(`select count(*) as n from ${sql}`, params)).rows[0]?.n);
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);
const errorCode = <T>(w: { kind: "ok"; value: T } | { kind: "error"; error: { code?: string } }) => (w.kind === "error" ? w.error.code : "ok");

const LogRow = z.object({ id: z.coerce.number(), action: z.string(), via: z.string(), actor: z.string().nullable(), before: z.unknown(), after: z.unknown(), at: z.date() });
const logOf = async (where: string, params: unknown[]) => z.array(LogRow).parse((await owner(`select id, action, via, actor, before, after, at from run_log where ${where} order by id`, params)).rows);
const sharingRows = (id: RunId) => logOf("run_id = $1 and action in ('run.share', 'export.allowed', 'export.blocked')", [id]);
const labRows = (labId: LabId) => logOf("lab_id = $1 and run_id is null", [labId]);

let lab: LabId;
let otherLab: LabId;
let benPerson: string;
let next = 0;

// A run Ben ran, made by Ada, in the lab.
async function newRun(person: string | null = benPerson): Promise<RunId> {
  next += 1;
  const { data, error } = await memberDb(ada).rpc("create_run", { p_lab_id: lab, p_shas: [sha((next % 6) + 1)], p_fields: JSON.stringify({ title: `Run ${next}`, status: "failed", person_id: person }) });
  if (error !== null) throw new Error(error.message);
  return RunId.parse(z.object({ id: z.string() }).parse(data).id);
}
// A run with both switches on, each turned on by the person whose switch it is.
async function sharedRun(): Promise<RunId> {
  expect(errorCode(await setLabShare(memberDb(ada), lab, true, V1))).toBe("ok");
  const id = await newRun();
  expect(errorCode(await setRunShare(memberDb(ben), id, true))).toBe("ok");
  return id;
}
// The worker building a folder from a grant, as the export will.
const build = (labId: LabId, runId: RunId, grantId: number) =>
  owner("insert into task_exports (lab_id, run_id, grant_id, purpose, storage_prefix) values ($1, $2, $3, 'task folder', 'exports/x') returning id", [labId, runId, grantId]).then((r) =>
    z.string().parse(r.rows[0]?.id),
  );
async function allowed(userId: string, id: RunId): Promise<number> {
  const gate = await askExportGate(memberDb(userId), id, "task folder");
  if (gate.kind !== "allowed") throw new Error(`blocked: ${gate.blocks.join(", ")}`);
  return gate.grantId;
}

beforeAll(async () => {
  await db.connect();
  await owner("insert into auth.users (id, email) values ($1, 'ada@share.test'), ($2, 'ben@share.test'), ($3, 'flo@share.test'), ($4, 'cy@share.test'), ($5, 'dee@share.test')", [ada, ben, flo, cy, dee]);
  const made = async (userId: string, name: string) => LabId.parse(CreateLabResult.parse((await memberDb(userId).rpc("create_lab", { p_name: name })).data));
  lab = await made(ada, "Sharing lab");
  otherLab = await made(cy, "Other sharing lab");
  await owner("insert into members (lab_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')", [lab, ben, flo]);
  benPerson = z.string().parse((await owner("insert into people (lab_id, display_name, member_user_id) values ($1, 'Ben Okoro', $2) returning id", [lab, ben])).rows[0]?.id);
  const source = (await owner("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/share') returning id", [lab])).rows[0]?.id;
  for (let n = 1; n <= 6; n += 1) {
    await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, 12, 'text/csv', 'spreadsheet')", [sha(n)]);
    await owner(
      `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
       values ($1, $2, $3, '/' || $3, $3, 12, now(), 'r', $4, 'indexed')`,
      [lab, source, `share${n}.csv`, sha(n)],
    );
  }
});

afterAll(async () => {
  await db.end();
});

describe("the lab's agreement", () => {
  it("is off until an admin agrees, and only an admin of this lab can", async () => {
    expect(await loadLabSharing(memberDb(ada), lab)).toEqual({ agreedAt: null, agreement: null, agreedBy: null, canChange: true, demo: false, built: 0 });
    expect((await loadLabSharing(memberDb(ben), lab)).canChange).toBe(false);
    for (const who of [ben, flo, cy, dee]) expect(errorCode(await setLabShare(memberDb(who), lab, true, V1))).toBe("42501");
    expect(errorCode(await setLabShare(memberDb(null, "anon"), lab, true, V1))).toBe("42501");
    expect(await labRows(lab)).toEqual([]);
    expect((await memberDb(cy).rpc("lab_sharing", { p_lab_id: lab })).data).toBeNull();
    expect(sharingFailure({ code: "42501" }, "lab")).toMatchObject({ status: 403 });
  });

  it("records who agreed, when, and to which wording, and logs every change with its before and after", async () => {
    const before = Date.now();
    const agreed = await setLabShare(memberDb(ada), lab, true, V1);
    expect(agreed).toMatchObject({ kind: "ok", value: { agreement: V1, agreedBy: "ada@share.test", canChange: true } });
    const [on] = await labRows(lab);
    expect(on).toMatchObject({ action: "lab.share", via: "person", actor: ada, before: { agreed_at: null, agreement: null }, after: { agreement: V1 } });
    expect(Math.abs((on?.at.getTime() ?? 0) - before)).toBeLessThan(60_000);

    // Agreeing again to the same wording changes nothing; a new wording is a new agreement.
    await setLabShare(memberDb(ada), lab, true, V1);
    expect(await labRows(lab)).toHaveLength(1);
    await setLabShare(memberDb(ada), lab, true, "draft-2");
    expect((await labRows(lab)).at(-1)).toMatchObject({ action: "lab.share", actor: ada, before: { agreement: V1 }, after: { agreement: "draft-2" } });

    expect(await setLabShare(memberDb(ada), lab, false, "")).toMatchObject({ kind: "ok", value: { agreedAt: null, agreement: null, agreedBy: null } });
    expect((await labRows(lab)).at(-1)).toMatchObject({ action: "lab.share", via: "person", actor: ada, before: { agreement: "draft-2" }, after: { agreed_at: null, agreement: null } });
    await setLabShare(memberDb(ada), lab, false, "");
    expect(await labRows(lab)).toHaveLength(3);
  });

  it("needs the wording's version, and is refused for a demo lab", async () => {
    expect(errorCode(await setLabShare(memberDb(ada), lab, true, "  "))).toBe("BL933");
    expect(errorCode(await setLabShare(memberDb(ada), lab, true, "x".repeat(101)))).toBe("BL933");
    await owner("update labs set plan = 'demo' where id = $1", [lab]);
    expect(errorCode(await setLabShare(memberDb(ada), lab, true, V1))).toBe("BL932");
    expect((await loadLabSharing(memberDb(ada), lab)).demo).toBe(true);
    await owner("update labs set plan = 'pilot' where id = $1", [lab]);
    expect((await loadLabSharing(memberDb(ada), lab)).agreedAt).toBeNull();
  });
});

describe("a run's switch", () => {
  it("is off by default, and only the person who ran it or an admin turns it on", async () => {
    const id = await newRun();
    expect(await loadRunSharing(memberDb(ben), id)).toMatchObject({ share: false, canChange: true });
    expect(await loadRunSharing(memberDb(ada), id)).toMatchObject({ share: false, canChange: true });
    expect(await loadRunSharing(memberDb(flo), id)).toMatchObject({ share: false, canChange: false });
    expect(await loadRunSharing(memberDb(cy), id)).toBeNull();

    expect(errorCode(await setRunShare(memberDb(flo), id, true))).toBe("BL931");
    expect(errorCode(await setRunShare(memberDb(cy), id, true))).toBe("42501");
    expect(errorCode(await setRunShare(memberDb(dee), id, true))).toBe("42501");
    expect(errorCode(await setRunShare(memberDb(null, "anon"), id, true))).toBe("42501");
    expect(errorCode(await setRunShare(memberDb(ben), RunId.parse("00000000-0000-4000-8000-00000000dead"), true))).toBe("BL907");
    expect(await sharingRows(id)).toEqual([]);
    expect(await count("runs where id = $1 and share", [id])).toBe(0);

    expect(await setRunShare(memberDb(ben), id, true)).toMatchObject({ kind: "ok", value: { share: true } });
    expect(await setRunShare(memberDb(ada), id, false)).toMatchObject({ kind: "ok", value: { share: false } });
    // Someone who can't turn it on can't turn it off either.
    await setRunShare(memberDb(ada), id, true);
    expect(errorCode(await setRunShare(memberDb(flo), id, false))).toBe("BL931");
    expect(await count("runs where id = $1 and share", [id])).toBe(1);
  });

  it("belongs to an admin alone when nobody with an account ran it", async () => {
    const id = await newRun(null);
    expect(errorCode(await setRunShare(memberDb(ben), id, true))).toBe("BL931");
    expect(errorCode(await setRunShare(memberDb(ada), id, true))).toBe("ok");
  });

  it("logs every change with who and when, once", async () => {
    const id = await newRun();
    const before = Date.now();
    await setRunShare(memberDb(ben), id, true);
    await setRunShare(memberDb(ben), id, true);
    await setRunShare(memberDb(ada), id, false);
    const log = await sharingRows(id);
    expect(log).toMatchObject([
      { action: "run.share", via: "person", actor: ben, before: { share: false }, after: { share: true } },
      { action: "run.share", via: "person", actor: ada, before: { share: true }, after: { share: false } },
    ]);
    for (const row of log) expect(Math.abs(row.at.getTime() - before)).toBeLessThan(60_000);
  });

  it("can't be turned on in a demo lab, but can still be turned off", async () => {
    const id = await newRun();
    await setRunShare(memberDb(ben), id, true);
    await owner("update labs set plan = 'demo' where id = $1", [lab]);
    const other = await newRun();
    expect(errorCode(await setRunShare(memberDb(ben), other, true))).toBe("BL932");
    expect(errorCode(await setRunShare(memberDb(ben), id, false))).toBe("ok");
    await owner("update labs set plan = 'pilot' where id = $1", [lab]);
  });
});

describe("the export gate", () => {
  it("blocks and logs an attempt when the run's switch, the lab's agreement, or both are off", async () => {
    await setLabShare(memberDb(ada), lab, false, "");
    const id = await newRun();
    expect(await askExportGate(memberDb(flo), id, "task folder")).toEqual({ kind: "blocked", blocks: ["run_off", "lab_off"] });
    await setRunShare(memberDb(ben), id, true);
    expect(await askExportGate(memberDb(flo), id, "task folder")).toEqual({ kind: "blocked", blocks: ["lab_off"] });
    await setLabShare(memberDb(ada), lab, true, V1);
    await setRunShare(memberDb(ben), id, false);
    expect(await askExportGate(memberDb(ada), id, "task folder")).toEqual({ kind: "blocked", blocks: ["run_off"] });

    const attempts = (await sharingRows(id)).filter((r) => r.action.startsWith("export."));
    expect(attempts).toMatchObject([
      { action: "export.blocked", via: "person", actor: flo, after: { blocks: ["run_off", "lab_off"], purpose: "task folder" } },
      { action: "export.blocked", via: "person", actor: flo, after: { blocks: ["lab_off"] } },
      { action: "export.blocked", via: "person", actor: ada, after: { blocks: ["run_off"] } },
    ]);
    // A blocked attempt's log row is no grant.
    for (const row of attempts) expect(await codeOf(build(lab, id, row.id))).toMatch(/^BL95[12]$/);
    expect(await count("task_exports where run_id = $1", [id])).toBe(0);
  });

  it("allows a run with both on, and the grant builds one folder, once, within the hour", async () => {
    const id = await sharedRun();
    expect(await loadRunSharing(memberDb(flo), id)).toMatchObject({ share: true, blocks: [], built: 0 });
    const gate = await askExportGate(memberDb(flo), id, "task folder");
    if (gate.kind !== "allowed") throw new Error("expected a grant");
    expect(Date.parse(gate.expiresAt) - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(Date.parse(gate.expiresAt) - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    expect((await sharingRows(id)).at(-1)).toMatchObject({ id: gate.grantId, action: "export.allowed", via: "person", actor: flo, after: { purpose: "task folder" } });

    await build(lab, id, gate.grantId);
    // Reused.
    expect(await codeOf(build(lab, id, gate.grantId))).toBe("23505");
    // Expired.
    const late = await allowed(flo, id);
    await owner("update run_log set at = now() - interval '61 minutes' where id = $1", [late]);
    expect(await codeOf(build(lab, id, late))).toBe("BL952");
    // Another run's.
    const other = await sharedRun();
    expect(await codeOf(build(lab, other, await allowed(flo, id)))).toBe("BL952");
    expect(await count("task_exports where run_id = any ($1::uuid[])", [[id, other]])).toBe(1);
  });

  it("blocks a run whose confirmed cause the named confirmer hasn't attested", async () => {
    await setLabShare(memberDb(ada), lab, true, V1);
    const id = await newRun();
    await owner("update runs set confirmed_cause = 'buffer pH was 9', confirmed_by = $2, confirm_method = 'control', confirmed_at = now() where id = $1", [id, benPerson]);
    await setRunShare(memberDb(ben), id, true);
    expect(await askExportGate(memberDb(ada), id, "task folder")).toEqual({ kind: "blocked", blocks: ["not_attested"] });
    expect(await loadRunSharing(memberDb(ada), id)).toMatchObject({ share: true, blocks: ["not_attested"] });
    expect((await sharingRows(id)).at(-1)).toMatchObject({ action: "export.blocked", actor: ada, after: { blocks: ["not_attested"] } });

    // The confirmer's own yes changes the run, so sharing goes off and is turned on again.
    await owner("update runs set confirmer_attested_at = now() where id = $1", [id]);
    expect(await askExportGate(memberDb(ada), id, "task folder")).toEqual({ kind: "blocked", blocks: ["run_off"] });
    await setRunShare(memberDb(ben), id, true);
    expect((await askExportGate(memberDb(ada), id, "task folder")).kind).toBe("allowed");
  });

  it("always blocks a demo lab, and a grant made before the lab became one builds nothing", async () => {
    const id = await sharedRun();
    const g = await allowed(ada, id);
    await owner("update labs set plan = 'demo' where id = $1", [lab]);
    expect(await askExportGate(memberDb(ada), id, "task folder")).toEqual({ kind: "blocked", blocks: ["demo_lab"] });
    expect(await codeOf(build(lab, id, g))).toBe("BL951");
    await owner("update labs set plan = 'pilot' where id = $1", [lab]);
  });

  it("tells another lab's member, someone in no lab and the worker there is no such run, and logs the attempt for the lab", async () => {
    const id = await sharedRun();
    const before = (await sharingRows(id)).length;
    for (const who of [cy, dee]) expect(await askExportGate(memberDb(who), id, "task folder")).toEqual({ kind: "blocked", blocks: ["no_such_run"] });
    const asWorker: RunDb = { rpc: async (fn, args) => ({ data: (await owner(`select ${fn}($1, $2) as v`, Object.values(args))).rows[0]?.v, error: null }) };
    expect(await askExportGate(asWorker, id, "task folder")).toEqual({ kind: "blocked", blocks: ["no_such_run"] });
    expect((await sharingRows(id)).slice(before)).toMatchObject([
      { action: "export.blocked", via: "person", actor: cy, after: { blocks: ["not_member"] } },
      { action: "export.blocked", via: "person", actor: dee, after: { blocks: ["not_member"] } },
      { action: "export.blocked", via: "worker", actor: null, after: { blocks: ["not_member"] } },
    ]);
    expect(await count("run_log where run_id = $1 and action = 'export.allowed'", [id])).toBe(0);

    // A run that isn't there answers the same and never raises; a signed-out caller can't ask.
    const logged = await count("run_log");
    expect(await askExportGate(memberDb(ada), RunId.parse("00000000-0000-4000-8000-00000000dead"), "x")).toEqual({ kind: "blocked", blocks: ["no_such_run"] });
    expect((await memberDb(ada).rpc("export_gate", { p_run_id: null, p_purpose: null })).data).toMatchObject({ allowed: false, grant_id: null });
    expect(await count("run_log")).toBe(logged);
    expect((await memberDb(null, "anon").rpc("export_gate", { p_run_id: id, p_purpose: "x" })).error?.code).toBe("42501");
  });

  it("gives a member no way round it: no grant of their own making, no folder, no switch flipped by hand", async () => {
    const id = await sharedRun();
    const g = await allowed(ben, id);
    const asBen = (sql: string, params: unknown[]) =>
      codeOf(
        (async () => {
          await db.query("begin");
          try {
            await db.query("set local role authenticated");
            await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ben })]);
            await db.query(sql, params);
            await db.query("commit");
          } catch (err) {
            await db.query("rollback");
            throw err;
          }
        })(),
      );
    expect(await asBen("insert into task_exports (lab_id, run_id, grant_id, purpose) values ($1, $2, $3, 'x')", [lab, id, g])).toBe("42501");
    expect(await asBen("insert into run_log (lab_id, run_id, via, action) values ($1, $2, 'person', 'export.allowed')", [lab, id])).toBe("42501");
    expect(await asBen("update run_log set at = now() where id = $1", [g])).toBe("42501");
    expect(await asBen("update runs set share = true where id = $1", [id])).toBe("42501");
    expect(await asBen("update labs set sharing_agreed_at = now(), sharing_agreement = 'x' where id = $1", [lab])).toBe("42501");
    expect(await asBen("select run_share_blocks($1)", [id])).toBe("42501");
    expect(await asBen("select can_share_run($1, $2)", [lab, benPerson])).toBe("42501");
    expect(await asBen("select assert_exportable($1)", [id])).toBe("42501");
  });

  it("a grant stops working the moment either switch goes off", async () => {
    const id = await sharedRun();
    const g = await allowed(ada, id);
    await setRunShare(memberDb(ben), id, false);
    expect(await codeOf(build(lab, id, g))).toBe("BL951");
    await setRunShare(memberDb(ben), id, true);
    const g2 = await allowed(ada, id);
    await setLabShare(memberDb(ada), lab, false, "");
    expect(await codeOf(build(lab, id, g2))).toBe("BL951");
    expect(await count("task_exports where run_id = $1", [id])).toBe(0);
  });
  it("a grant made while the cause was attested builds nothing once the cause changes unattested", async () => {
    const id = await sharedRun();
    const person = z.object({ id: z.string() }).parse((await owner("select id from people where lab_id = $1 limit 1", [lab])).rows[0]).id;
    await owner("update runs set share = false where id = $1", [id]);
    await owner(
      `update runs set status = 'failed', status_at = now(), confirmed_cause = 'a', confirmed_by = $2, confirm_method = 'pi_opinion',
         confirmed_at = now(), confirmer_attested_at = now() where id = $1`,
      [id, person],
    );
    await owner("update runs set share = true where id = $1", [id]);
    const g = await allowed(ada, id);
    await owner("update runs set confirmed_cause = 'b', confirmer_attested_at = null where id = $1", [id]);
    await owner("update runs set share = true where id = $1", [id]);
    expect(await codeOf(build(lab, id, g))).toBe("BL951");
    expect(await count("task_exports where run_id = $1", [id])).toBe(0);
  });
});

describe("switching off after a folder was built", () => {
  it("withdraws the run's folders, and logs that copies already sent can't be pulled back", async () => {
    const id = await sharedRun();
    const task = await build(lab, id, await allowed(ada, id));
    expect(await loadRunSharing(memberDb(ben), id)).toMatchObject({ built: 1, withdrawn: 0 });
    await owner("select assert_exportable($1)", [task]);

    await setRunShare(memberDb(ben), id, false);
    expect(await count("task_exports where id = $1 and withdrawn_at is not null", [task])).toBe(1);
    expect(await loadRunSharing(memberDb(ben), id)).toMatchObject({ share: false, built: 0, withdrawn: 1 });
    expect((await sharingRows(id)).slice(-2)).toMatchObject([
      { action: "run.share", via: "person", actor: ben, after: { share: false } },
      { action: "export.blocked", via: "person", actor: ben, after: { blocks: ["withdrawn"], folders: 1, sent_copies: "cannot be pulled back" } },
    ]);
    expect(await codeOf(owner("select assert_exportable($1)", [task]))).toBe("BL951");
    expect(await codeOf(owner("insert into task_model_runs (task_id, lab_id, model) values ($1, $2, 'model-a')", [task, lab]))).toBe("BL951");
    // On again doesn't bring the folder back.
    await setRunShare(memberDb(ben), id, true);
    expect(await codeOf(owner("select assert_exportable($1)", [task]))).toBe("BL951");
    expect(await codeOf(owner("update task_exports set withdrawn_at = null where id = $1", [task]))).toBe("BL952");

    // With no folder standing there is nothing to say about copies.
    await setRunShare(memberDb(ben), id, false);
    expect((await sharingRows(id)).at(-1)).toMatchObject({ action: "run.share", after: { share: false } });
  });

  it("withdraws every folder in the lab when the agreement is taken back, and logs the same", async () => {
    const one = await sharedRun();
    const two = await sharedRun();
    const tasks = [await build(lab, one, await allowed(ada, one)), await build(lab, two, await allowed(ada, two))];
    expect((await loadLabSharing(memberDb(ada), lab)).built).toBe(2);

    await setLabShare(memberDb(ada), lab, false, "");
    expect(await count("task_exports where id = any ($1::uuid[]) and withdrawn_at is not null", [tasks])).toBe(2);
    expect((await loadLabSharing(memberDb(ada), lab)).built).toBe(0);
    expect((await labRows(lab)).slice(-2)).toMatchObject([
      { action: "lab.share", via: "person", actor: ada, after: { agreement: null } },
      { action: "export.blocked", via: "person", actor: ada, after: { blocks: ["withdrawn"], folders: 2, sent_copies: "cannot be pulled back" } },
    ]);
    for (const task of tasks) expect(await codeOf(owner("select assert_exportable($1)", [task]))).toBe("BL951");
  });

  it("withdraws the folder when a shared run is changed, by the foundation's trigger", async () => {
    const id = await sharedRun();
    const task = await build(lab, id, await allowed(ada, id));
    expect((await memberDb(flo).rpc("edit_run", { p_run_id: id, p_fields: JSON.stringify({ title: "Renamed" }) })).error).toBeNull();
    expect(await loadRunSharing(memberDb(ben), id)).toMatchObject({ share: false, built: 0, withdrawn: 1 });
    expect(await count("task_exports where id = $1 and withdrawn_at is not null", [task])).toBe(1);
    expect((await sharingRows(id)).at(-1)).toMatchObject({ action: "run.share", via: "trigger", actor: flo, after: { share: false } });
  });
});

describe("the sharing log", () => {
  it("is read by any member for a run and by an admin for the lab, with names, newest first", async () => {
    await setLabShare(memberDb(ada), lab, true, V1);
    const id = await newRun();
    await setRunShare(memberDb(ben), id, true);
    await askExportGate(memberDb(flo), id, "task folder");
    await askExportGate(memberDb(cy), id, "task folder");
    await setRunShare(memberDb(ada), id, false);

    const mine = await loadSharingLog(memberDb(flo), lab, id);
    if (mine.kind !== "ok") throw new Error("a member reads a run's log");
    expect(mine.value.map((e) => [e.action, e.actorName, e.runId])).toEqual([
      ["run.share", "ada@share.test", id],
      ["export.blocked", null, id],
      ["export.allowed", "flo@share.test", id],
      ["run.share", "Ben Okoro", id],
    ]);
    expect(mine.value.map((e) => sharingLogLine(e, "this run"))).toEqual([
      "ada@share.test turned sharing off for this run.",
      "Someone who isn't in the lab asked to export this run. Blocked.",
      "flo@share.test asked to export this run. Allowed.",
      "Ben Okoro turned sharing on for this run.",
    ]);
    expect(mine.value.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);

    const whole = await loadSharingLog(memberDb(ada), lab, null);
    if (whole.kind !== "ok") throw new Error("an admin reads the lab's log");
    expect(whole.value.slice(0, 4).map((e) => e.id)).toEqual(mine.value.map((e) => e.id));
    expect(whole.value.some((e) => e.action === "lab.share" && e.runId === null)).toBe(true);
    expect(whole.value.find((e) => e.runId === id)?.runTitle).toMatch(/^Run /);
    // Only sharing: a run's other edits stay in its own history.
    expect(new Set(whole.value.map((e) => e.action))).toEqual(new Set(["run.share", "lab.share", "export.allowed", "export.blocked"]));
  });

  it("refuses the lab's log to a member who isn't an admin, and both to anyone outside the lab", async () => {
    const id = await newRun();
    await setRunShare(memberDb(ben), id, true);
    expect(errorCode(await loadSharingLog(memberDb(ben), lab, null))).toBe("42501");
    for (const who of [cy, dee]) {
      expect(errorCode(await loadSharingLog(memberDb(who), lab, null))).toBe("42501");
      expect(errorCode(await loadSharingLog(memberDb(who), lab, id))).toBe("42501");
    }
    expect(errorCode(await loadSharingLog(memberDb(null, "anon"), lab, id))).toBe("42501");
    // Their own lab's id with our run gets them nothing.
    expect(await loadSharingLog(memberDb(cy), otherLab, id)).toEqual({ kind: "ok", value: [] });
  });
});

describe("grants", () => {
  it("gives members the six sharing functions and keeps the two helpers from them; signed-out callers get none", async () => {
    const fns = z.array(z.object({ name: z.string(), member: z.boolean(), anon: z.boolean(), definer: z.boolean() })).parse(
      (
        await owner(
          `select p.proname as name, has_function_privilege('authenticated', p.oid, 'execute') as member,
             has_function_privilege('anon', p.oid, 'execute') as anon, p.prosecdef as definer
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any ($1) order by 1`,
          [["can_share_run", "export_gate", "lab_sharing", "run_share_blocks", "run_sharing", "set_lab_share", "set_run_share", "sharing_log"]],
        )
      ).rows,
    );
    expect(fns.filter((f) => f.anon)).toEqual([]);
    expect(fns.filter((f) => f.member).map((f) => f.name)).toEqual(["export_gate", "lab_sharing", "run_sharing", "set_lab_share", "set_run_share", "sharing_log"]);
    expect(fns.filter((f) => !f.member).map((f) => f.name)).toEqual(["can_share_run", "run_share_blocks"]);
    expect(fns.every((f) => f.definer)).toBe(true);
  });
});
