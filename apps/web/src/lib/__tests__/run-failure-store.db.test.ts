import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { LabId, PersonId, RunId, Sha256 } from "../ids";
import type { RunDb } from "../run-record-store";

// The failure record's store (lib/run-failure-store.ts) against the real migrations, through a
// stand-in that calls each database function the way supabase-js does: by name, with named
// arguments, as the member under RLS. A wrong function name, argument name or shape fails here.

vi.mock("server-only", () => ({}));

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const fay = "00000000-0000-4000-8000-0000000f7001";
const gus = "00000000-0000-4000-8000-0000000f7002";
const sha = (n: number) => Sha256.parse(`b7${n.toString(16).padStart(62, "0")}`);

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
let run: RunId;
let gusRow: PersonId;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'fay@failstore.test'), ($2, 'gus@failstore.test')", [fay, gus]);
  lab = LabId.parse(CreateLabResult.parse((await memberDb(fay).rpc("create_lab", { p_name: "Failure store lab" })).data));
  await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, gus]);
  gusRow = PersonId.parse((await db.query("insert into people (lab_id, display_name, member_user_id) values ($1, 'Gus', $2) returning id", [lab, gus])).rows[0]?.id);
  const source = (await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/fs') returning id", [lab])).rows[0]?.id;
  await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 12, 'image/tiff', 'image')", [sha(1)]);
  await db.query(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, 'blot.tif', '/blot.tif', 'blot.tif', 12, now(), 'r', $3, 'indexed')`,
    [lab, source, sha(1)],
  );
  const { createRun } = await import("../run-record-store");
  const made = await createRun(memberDb(fay), lab, [sha(1)], { title: "Blot", status: "failed" });
  if (made.kind !== "ok") throw new Error("the run wasn't made");
  run = made.value.id;
});

afterAll(async () => {
  await db.end();
});

describe("the failure record's store", () => {
  it("writes a suspected cause, confirms it with evidence, takes the confirmer's yes and sets a failure type", async () => {
    const store = await import("../run-failure-store");
    const fayDb = memberDb(fay);
    const gusDb = memberDb(gus);

    const list = await store.loadFailureList(fayDb);
    expect([list.version, list.signedOffAt, list.terms.length]).toEqual([1, null, 44]);
    expect(await store.loadConfirmerChoices(gusDb, run)).toEqual([{ id: gusRow, name: "Gus", you: true, account: true }]);

    const suspected = await store.setSuspectedCause(fayDb, run, "Blocking too short");
    expect(suspected.kind === "ok" && suspected.value.failure.suspectedCause).toBe("Blocking too short");

    const confirmed = await store.confirmCause(fayDb, run, {
      cause: "Blocking was 10 minutes, not an hour",
      personId: gusRow,
      evidence: { method: "control", sha256: sha(1) },
      note: null,
      confirmedAt: "2026-11-12T12:00:00.000Z",
    });
    expect(confirmed.kind === "ok" && confirmed.value.failure).toMatchObject({ confirmMethod: "control", confirmSha256: sha(1), confirmedBy: { name: "Gus" }, confirmerAttestedAt: null });

    expect(await store.attestCause(fayDb, run)).toMatchObject({ kind: "error", error: { code: "BL912" } });
    const yes = await store.attestCause(gusDb, run);
    expect(yes.kind === "ok" && yes.value.failure.confirmerAttestedAt).not.toBeNull();

    const typed = await store.setFailureType(gusDb, run, { version: 1, technique: "tech.western", failedStep: "step.handling", causeCategory: null });
    expect(typed.kind === "ok" && typed.value.failure).toMatchObject({ technique: "tech.western", failedStep: "step.handling", causeCategory: null });
    expect(await store.setFailureType(gusDb, run, { version: 1, technique: "tech.nope", failedStep: null, causeCategory: null })).toMatchObject({ kind: "error", error: { code: "BL916" } });
    const untyped = await store.setFailureType(gusDb, run, null);
    expect(untyped.kind === "ok" && untyped.value.failure.taxonomyVersion).toBeNull();

    const withdrawn = await store.withdrawCause(gusDb, run);
    expect(withdrawn.kind === "ok" && withdrawn.value.failure).toMatchObject({ confirmedCause: null, confirmerAttestedAt: null, suspectedCause: "Blocking too short" });
  });

  it("links an unlinked confirmer with This is me, and refuses a second person", async () => {
    const hal = "00000000-0000-4000-8000-0000000f7003";
    await db.query("insert into auth.users (id, email) values ($1, 'hal@failstore.test')", [hal]);
    await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, hal]);
    const halRow = PersonId.parse((await db.query("insert into people (lab_id, display_name) values ($1, 'Hal Brook') returning id", [lab])).rows[0]?.id);
    const store = await import("../run-failure-store");
    await store.confirmCause(memberDb(fay), run, { cause: "Hal saw it", personId: halRow, evidence: { method: "pi_opinion" }, note: null, confirmedAt: null });
    const claimed = await store.claimConfirmer(memberDb(hal), run, halRow);
    expect(claimed.kind === "ok" && claimed.value.id).toBe(run);
    expect((await store.loadConfirmerChoices(memberDb(hal), run)).find((c) => c.id === halRow)).toMatchObject({ you: true, account: true });
    const attested = await store.attestCause(memberDb(hal), run);
    expect(attested.kind === "ok" && attested.value.failure.confirmerAttestedAt).not.toBeNull();
    const again = await store.claimConfirmer(memberDb(hal), run, gusRow);
    if (again.kind !== "error") throw new Error("a second person was claimed");
    expect(await store.failureError(again.error, { event: "test", labId: lab }).json()).toEqual({ error: "That person is already linked to another account. An admin can unlink them in Settings, People." });
  });

  it("turns each failure code into its own plain answer", async () => {
    const store = await import("../run-failure-store");
    const refused = await store.confirmCause(memberDb(fay), run, {
      cause: "Too late",
      personId: gusRow,
      evidence: { method: "pi_opinion" },
      note: null,
      confirmedAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (refused.kind !== "error") throw new Error("a future date was saved");
    const response = store.failureError(refused.error, { event: "test", labId: lab });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That time is in the future. Pick when it was confirmed." });
    expect((await store.failureError({ code: "42501", message: "" }, { event: "test", labId: lab }).json()).error).toBe("That run belongs to another lab.");
  });
});
