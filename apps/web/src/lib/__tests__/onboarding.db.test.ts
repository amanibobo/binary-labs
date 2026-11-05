import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import type { LabId } from "../ids";
import { checklist, noteArgs, OnboardingRows, ProgressRows, summarize, type OnboardingEvent } from "../onboarding";

// note_onboarding, the onboarding table's RLS and onboarding_progress, through the web app's
// arguments and parsers, as the `authenticated` role, serializing rows the way PostgREST does.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ida = "00000000-0000-4000-8000-0000000001a1";
const jon = "00000000-0000-4000-8000-0000000001a2";
const kit = "00000000-0000-4000-8000-0000000001a3";
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

async function rows(sql: string, params: unknown[] = []): Promise<unknown> {
  const res = await db.query(`select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from ${sql} r`, params);
  return z.object({ rows: z.unknown() }).parse(res.rows[0]).rows;
}

async function sqlState(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return z.object({ code: z.string().optional() }).parse(err).code;
  }
  throw new Error("expected the call to fail");
}

const note = (userId: string, event: OnboardingEvent) =>
  asUser(userId, async () => {
    const args = noteArgs(event);
    await db.query("select note_onboarding($1, $2)", [args.p_kind, args.p_value]);
  });

const STATE = "(select welcome_seen_at, tour_step, tour_ended, tour_ended_at, checklist_hidden_at, hints_seen from onboarding)";
const stateOf = (userId: string) => asUser(userId, async () => OnboardingRows.parse(await rows(STATE)));
const progressOf = (userId: string, labId: LabId) => asUser(userId, async () => rows("onboarding_progress($1)", [labId]));

let lab: LabId;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'ida@lab.edu'), ($2, 'jon@lab.edu'), ($3, 'kit@lab.edu')", [ida, jon, kit]);
  lab = CreateLabResult.parse(await asUser(ida, async () => (await db.query("select create_lab('Ida Lab') as id")).rows[0]?.id));
});

afterAll(async () => {
  await db.end();
});

describe("onboarding state", () => {
  it("starts fresh and records what the person did, safely repeated", async () => {
    expect((await stateOf(ida)).welcomeSeen).toBe(false);
    await note(ida, { kind: "welcome" });
    await note(ida, { kind: "welcome" });
    await note(ida, { kind: "tour_step", step: 3 });
    await note(ida, { kind: "tour_step", step: 2 });
    await note(ida, { kind: "tour_done" });
    await note(ida, { kind: "tour_skipped" });
    await note(ida, { kind: "hint", hint: "check-this" });
    await note(ida, { kind: "hint", hint: "check-this" });
    expect(await stateOf(ida)).toMatchObject({ welcomeSeen: true, tourStep: 3, tourEnded: { how: "done" }, checklistHidden: false, hintsSeen: ["check-this"] });

    await note(ida, { kind: "tour_step", step: 1 });
    expect((await stateOf(ida)).tourEnded).toBeNull();
  });

  it("keeps each person's state to themselves", async () => {
    await note(jon, { kind: "hide_checklist" });
    const seen = await asUser(jon, () => rows("(select user_id from onboarding)"));
    expect(seen).toEqual([{ user_id: jon }]);

    expect(await sqlState(() => asUser(jon, () => db.query("insert into onboarding (user_id) values ($1)", [ida])))).toBe("42501");
    const updated = await asUser(jon, () => db.query("update onboarding set hints_seen = '{}' where user_id = $1", [ida]));
    expect(updated.rowCount).toBe(0);
    expect((await stateOf(ida)).hintsSeen).toEqual(["check-this"]);
  });

  it("refuses kinds and values it doesn't know", async () => {
    const bad = (kind: string, value: string | null) => sqlState(() => asUser(ida, () => db.query("select note_onboarding($1, $2)", [kind, value])));
    expect(await bad("confetti", null)).toBe("22023");
    expect(await bad("tour_step", "99")).toBe("22023");
    expect(await bad("hint", "Not A Hint")).toBe("22023");
  });

  it("goes when the user does", async () => {
    await db.query("insert into auth.users (id) values ('00000000-0000-4000-8000-0000000001af')");
    await note("00000000-0000-4000-8000-0000000001af", { kind: "welcome" });
    await db.query("delete from auth.users where id = '00000000-0000-4000-8000-0000000001af'");
    const left = await db.query("select count(*)::int as n from onboarding where user_id = '00000000-0000-4000-8000-0000000001af'");
    expect(left.rows[0]).toEqual({ n: 0 });
  });
});

describe("checklist progress", () => {
  it("is worked out from what the lab and the caller actually did", async () => {
    const before = ProgressRows.parse(await progressOf(ida, lab));
    expect(before.joinedAt).not.toBeNull();
    expect(summarize(checklist({ role: "admin", progress: before, state: await stateOf(ida) }))).toEqual({ kind: "in_progress", done: 0, total: 5 });

    await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, jon]);
    await asUser(ida, async () => {
      await db.query("insert into audit_log (lab_id, actor, action, target) values ($1, $2, 'search', 'p450')", [lab, ida]);
      await db.query("select create_protocol($1, 'protocol', 'Lysis', 'Thaw on ice.', null, null)", [lab]);
      await db.query("select record_upload($1, $2, 10, 'gel.jpg', null, $3::date, null)", [lab, "a".repeat(64), today]);
    });

    const admin = ProgressRows.parse(await progressOf(ida, lab));
    const items = checklist({ role: "admin", progress: admin, state: await stateOf(ida) });
    expect(items.filter((i) => i.doneAt === null).map((i) => i.id)).toEqual([]);
    expect(summarize(items).kind).toBe("complete");

    // Jon sees the lab's facts, but Ida's search and upload aren't his.
    const member = ProgressRows.parse(await progressOf(jon, lab));
    expect(member).toMatchObject({ searchedAt: null, uploadedAt: null, correctedAt: null });
    expect(member.invitedAt).not.toBeNull();
    expect(member.protocolAt).not.toBeNull();
  });

  it("answers nothing about a lab the caller isn't in", async () => {
    expect(await progressOf(kit, lab)).toEqual([]);
  });
});
