import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { LabId, RunId, Sha256 } from "../ids";
import type { RunDb } from "../run-record-store";

// The routes' core (lib/run-record-store.ts) against the real migrations. The stand-in below
// calls each database function the way supabase-js does: by name, with named arguments, as
// the member under RLS, a set-returning function coming back as an array. A wrong function
// name, argument name or return shape in the store fails here.

vi.mock("server-only", () => ({}));

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const eve = "00000000-0000-4000-8000-0000000f1001";
const mal = "00000000-0000-4000-8000-0000000f1002";
const sha = (n: number) => Sha256.parse(`9${n.toString(16).padStart(63, "0")}`);

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
        const res = await db.query(set ? `select coalesce(jsonb_agg(r), '[]'::jsonb) as v from ${call} r` : `select ${call} as v`, Object.values(args).map((v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v)));
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

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'eve@store.test'), ($2, 'mal@store.test')", [eve, mal]);
  const made = async (userId: string, name: string) => {
    const { data } = await memberDb(userId).rpc("create_lab", { p_name: name });
    return LabId.parse(CreateLabResult.parse(data));
  };
  lab = await made(eve, "Store lab");
  await made(mal, "Other store lab");
  const source = (await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/s') returning id", [lab])).rows[0]?.id;
  for (const n of [1, 2, 3]) {
    await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 12, 'text/csv', 'spreadsheet')", [sha(n)]);
    await db.query(
      `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
       values ($1, $2, $3, '/' || $3, $3, 12, now(), 'r', $4, 'indexed')`,
      [lab, source, `store${n}.csv`, sha(n)],
    );
  }
  await db.query(
    "insert into labels (lab_id, sha256, status, clean_name, date, confidence, source, outcome) values ($1, $2, 'accepted', 'Store plate 3', '2026-11-12', 0.9, 'human', 'failed')",
    [lab, sha(3)],
  );
});

afterAll(async () => {
  await db.end();
});

describe("the run record's store", () => {
  it("makes, reads, edits, marks, links and lists runs through the database's functions", async () => {
    const store = await import("../run-record-store");
    const me = memberDb(eve);

    expect((await store.loadRunSuggestions(me, lab)).map((s) => [s.title, s.fileSays])).toEqual([["Store plate 3", "failed"]]);

    const first = await store.createRun(me, lab, [sha(1)], { title: "First go", startedOn: "2026-11-10", status: "failed" });
    if (first.kind !== "ok") throw new Error(first.error.message);
    const second = await store.createRun(me, lab, [sha(3), sha(2)], {});
    if (second.kind !== "ok") throw new Error(second.error.message);
    expect(second.value).toMatchObject({ title: "Store plate 3", startedOn: "2026-11-12", status: "failed", statusBy: null });
    expect(await store.loadRunSuggestions(me, lab)).toEqual([]);

    expect((await store.loadRun(me, first.value.id))?.title).toBe("First go");
    const edited = await store.editRun(me, second.value.id, { title: "Second go", endedOn: "2026-11-13" });
    expect(edited).toMatchObject({ kind: "ok", value: { title: "Second go", endedOn: "2026-11-13" } });

    expect(await store.setRunStatus(me, second.value.id, "odd", false)).toMatchObject({ kind: "ok", value: { kind: "saved", run: { status: "odd" } } });
    await db.query("update runs set suspected_cause = 'the buffer' where id = $1", [second.value.id]);
    expect(await store.setRunStatus(me, second.value.id, "worked", false)).toEqual({ kind: "ok", value: { kind: "has_causes" } });
    expect(await store.setRunStatus(me, second.value.id, "worked", true)).toMatchObject({ kind: "ok", value: { kind: "saved", run: { status: "worked", failure: { suspectedCause: null } } } });

    expect((await store.loadRetryCandidates(me, second.value.id, "first")).map((r) => r.id)).toEqual([first.value.id]);
    expect(await store.linkRetry(me, second.value.id, first.value.id)).toMatchObject({ kind: "ok", value: { retryOf: { id: first.value.id } } });
    expect(await store.linkRetry(me, first.value.id, second.value.id)).toMatchObject({ kind: "error", error: { code: "BL903" } });

    expect(await store.addRunFiles(me, first.value.id, [sha(2)], "shared_control")).toMatchObject({ kind: "ok", value: { files: [{ role: "evidence" }, { role: "shared_control" }] } });
    expect(await store.removeRunFile(me, first.value.id, sha(2))).toMatchObject({ kind: "ok", value: { files: [{ sha256: sha(1) }] } });
    expect(await store.removeRunFile(me, first.value.id, sha(1))).toMatchObject({ kind: "error", error: { code: "BL902" } });

    expect((await store.loadFileRuns(me, lab, [sha(1), sha(2), sha(3)])).map((r) => [r.sha256, r.runId])).toEqual([
      [sha(1), first.value.id],
      [sha(2), second.value.id],
      [sha(3), second.value.id],
    ]);
    expect((await store.loadLabRuns(me, lab, {}, 0)).map((r) => [r.title, r.status, r.files])).toEqual([
      ["Second go", "worked", 2],
      ["First go", "failed", 1],
    ]);
    expect((await store.loadLabRuns(me, lab, { status: "failed" }, 0)).map((r) => r.title)).toEqual(["First go"]);
    expect(await store.loadLabRuns(me, lab, {}, 2)).toEqual([]);

    expect(await store.loadRunFile(me, first.value.id, sha(1))).toEqual({ originalName: "store1.csv", mime: "text/csv", kept: false });
    expect(await store.loadRunFile(me, first.value.id, sha(3))).toBeNull();

    await store.dismissRunSuggestions(me, lab);
    expect(await db.query("select 1 from run_suggestion_dismissals where lab_id = $1 and user_id = $2", [lab, eve])).toMatchObject({ rowCount: 1 });
  });

  it("gives another lab's member nothing, and refuses their writes", async () => {
    const store = await import("../run-record-store");
    const [run] = await store.loadLabRuns(memberDb(eve), lab, {}, 0);
    if (run === undefined) throw new Error("the first test made runs");
    const them = memberDb(mal);
    expect(await store.loadRun(them, run.id)).toBeNull();
    expect(await store.loadLabRuns(them, lab, {}, 0)).toEqual([]);
    expect(await store.loadFileRuns(them, lab, [sha(1)])).toEqual([]);
    expect(await store.loadRunFile(them, run.id, sha(3))).toBeNull();
    expect(await store.setRunStatus(them, run.id, "failed", true)).toMatchObject({ kind: "error", error: { code: "42501" } });
    expect(await store.createRun(them, lab, [sha(1)], {})).toMatchObject({ kind: "error", error: { code: "42501" } });
    expect(await store.loadRun(them, RunId.parse("00000000-0000-4000-8000-000000000998"))).toBeNull();
  });
});
