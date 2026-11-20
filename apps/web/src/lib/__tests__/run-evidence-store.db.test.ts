import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { LabId, ProtocolVersionId, RunId, Sha256 } from "../ids";
import type { RunDb } from "../run-record-store";

// The routes' core for planned versus actual (lib/run-evidence-store.ts) against the real
// migrations, through a stand-in that calls each function by name with named arguments, as
// supabase-js does. A wrong function name, argument name or return shape fails here.

vi.mock("server-only", () => ({}));

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const eve = "00000000-0000-4000-8000-0000000b2101";
const mal = "00000000-0000-4000-8000-0000000b2102";
const sha = (n: number) => Sha256.parse(`d${n.toString(16).padStart(63, "0")}`);

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

let lab: LabId;
let version: ProtocolVersionId;
let theirs: ProtocolVersionId;
let place: string;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'eve@evidence-store.test'), ($2, 'mal@evidence-store.test')", [eve, mal]);
  const made = async (userId: string, name: string) => LabId.parse(CreateLabResult.parse((await memberDb(userId).rpc("create_lab", { p_name: name })).data));
  lab = await made(eve, "Evidence store lab");
  const otherLab = await made(mal, "Other evidence store lab");
  const protocol = async (userId: string, labId: LabId, title: string) =>
    ProtocolVersionId.parse(
      z.array(z.object({ version_id: z.string() })).parse((await memberDb(userId).rpc("create_protocol", { p_lab_id: labId, p_kind: "protocol", p_title: title, p_body: "1. Mix.\n2. Spin.\n" })).data)[0]
        ?.version_id,
    );
  version = await protocol(eve, lab, "Store protocol");
  theirs = await protocol(mal, otherLab, "Their protocol");
  const source = (await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/s') returning id", [lab])).rows[0]?.id;
  for (const n of [1, 2]) await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 12, 'text/csv', 'spreadsheet')", [sha(n)]);
  place = z
    .string()
    .parse(
      (
        await db.query(
          `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
           values ($1, $2, 'store.csv', '/store.csv', 'store.csv', 12, now(), 'r', $3, 'indexed') returning id`,
          [lab, source, sha(1)],
        )
      ).rows[0]?.id,
    );
});

afterAll(async () => {
  await db.end();
});

describe("the evidence store", () => {
  it("picks a plan, saves what was done, and reads the choices, the texts and the edited files", async () => {
    const core = await import("../run-record-store");
    const store = await import("../run-evidence-store");
    const me = memberDb(eve);
    const run = await core.createRun(me, lab, [sha(1)], { title: "Store run" });
    if (run.kind !== "ok") throw new Error(run.error.message);
    const id = run.value.id;

    expect((await store.loadPlanChoices(me, id, ""))?.map((c) => c.title)).toEqual(["Store protocol"]);
    const planned = await store.setRunPlan(me, id, version);
    expect(planned.kind === "ok" && planned.value.plan.planned?.versionId).toBe(version);
    const saved = await store.saveAsRun(me, id, "1. Mix.\n2. Spin twice.\n", version);
    expect(saved.kind === "ok" && saved.value.plan.asRun?.basedOn).toBe(version);
    expect(await store.loadPlanBodies(me, id)).toEqual({ planned: "1. Mix.\n2. Spin.\n", basedOn: { versionId: version, title: "Store protocol", version: 1, body: "1. Mix.\n2. Spin.\n" } });

    expect(await store.loadEditedFiles(me, id)).toEqual([]);
    await db.query("update file_locations set sha256 = $2 where id = $1", [place, sha(2)]);
    expect((await store.loadEditedFiles(me, id))?.map((f) => [f.locationId, f.heldVersion, f.latestVersion])).toEqual([[place, 1, 2]]);
  });

  it("is null for another lab's run, and says why a write was refused in plain words", async () => {
    const core = await import("../run-record-store");
    const store = await import("../run-evidence-store");
    const run = await core.createRun(memberDb(eve), lab, [sha(2)], { title: "Another" });
    if (run.kind !== "ok") throw new Error(run.error.message);
    const them = memberDb(mal);
    expect(await store.loadEditedFiles(them, run.value.id)).toBeNull();
    expect(await store.loadPlanBodies(them, run.value.id)).toBeNull();
    expect(await store.loadPlanChoices(them, run.value.id, "")).toBeNull();

    const refused = await store.setRunPlan(memberDb(eve), run.value.id, theirs);
    if (refused.kind !== "error") throw new Error("another lab's version was taken");
    const response = store.evidenceError(refused.error, { event: "test", labId: lab });
    expect([response.status, await response.json()]).toEqual([400, { error: "That protocol isn't in this lab. Pick another." }]);

    const tooLong = await store.saveAsRun(memberDb(eve), run.value.id, "x".repeat(200_001), null);
    if (tooLong.kind !== "error") throw new Error("a text over the limit was saved");
    expect(store.evidenceError(tooLong.error, { event: "test", labId: lab }).status).toBe(400);

    const missing = await store.saveAsRun(memberDb(eve), RunId.parse("00000000-0000-4000-8000-00000000beef"), "1. Mix.", null);
    if (missing.kind !== "error") throw new Error("a run that isn't there was written");
    expect(store.evidenceError(missing.error, { event: "test", labId: lab }).status).toBe(404);
  });
});
