import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { LabId, UserId } from "../ids";
import { asRole, rows, scalar } from "./pg-ask";

vi.mock("server-only", () => ({}));

// Removing a member, changing a role and the lab's AI limit, against the real migrations.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const dee = UserId.parse("00000000-0000-4000-8000-0000000de001");
const eli = UserId.parse("00000000-0000-4000-8000-0000000de002");
const fay = UserId.parse("00000000-0000-4000-8000-0000000de003");
const gus = UserId.parse("00000000-0000-4000-8000-0000000de004");
const as = (userId: UserId) => ({ kind: "member" as const, userId });

let lab: LabId;
let other: LabId;

async function code(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return z.object({ code: z.string().optional() }).parse(err).code;
  }
  throw new Error("expected the call to fail");
}

const call = (userId: UserId, sql: string, params: unknown[]) => asRole(db, as(userId), () => db.query(`select ${sql}`, params));
const roles = async () =>
  Object.fromEntries((await db.query("select user_id, role from members where lab_id = $1", [lab])).rows.map((r: { user_id: string; role: string }) => [r.user_id, r.role]));
const audited = async (action: string) => Number((await db.query("select count(*) as n from audit_log where lab_id = $1 and action::text = $2", [lab, action])).rows[0]?.n);

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'dee.members@lab.test'), ($2, 'eli.members@lab.test'), ($3, 'fay.members@lab.test'), ($4, 'gus.members@other.test')", [dee, eli, fay, gus]);
  lab = CreateLabResult.parse(await asRole(db, as(dee), () => scalar(db, "create_lab('Members Lab')", [])));
  other = CreateLabResult.parse(await asRole(db, as(gus), () => scalar(db, "create_lab('Other Members Lab')", [])));
  await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')", [lab, eli, fay]);
});

afterAll(async () => {
  await db.query("delete from labs where id = any($1)", [[lab, other]]);
  await db.end();
});

describe("roles", () => {
  it("lets an admin make a member an admin and back, audited", async () => {
    await call(dee, "set_member_role($1, $2, 'admin')", [lab, eli]);
    expect((await roles())[eli]).toBe("admin");
    await call(dee, "set_member_role($1, $2, 'member')", [lab, eli]);
    expect((await roles())[eli]).toBe("member");
    expect(await audited("member.role")).toBe(2);
  });

  it("keeps the last admin from stepping down, but not one of two", async () => {
    expect(await code(() => call(dee, "set_member_role($1, $2, 'member')", [lab, dee]))).toBe("BL821");
    expect((await roles())[dee]).toBe("admin");
    await call(dee, "set_member_role($1, $2, 'admin')", [lab, eli]);
    await call(dee, "set_member_role($1, $2, 'member')", [lab, dee]);
    expect(await roles()).toMatchObject({ [dee]: "member", [eli]: "admin" });
    await call(eli, "set_member_role($1, $2, 'admin')", [lab, dee]);
    await call(dee, "set_member_role($1, $2, 'member')", [lab, eli]);
  });

  it("refuses members and other labs' admins", async () => {
    expect(await code(() => call(fay, "set_member_role($1, $2, 'admin')", [lab, fay]))).toBe("42501");
    expect(await code(() => call(gus, "set_member_role($1, $2, 'admin')", [lab, gus]))).toBe("42501");
    expect(await code(() => call(dee, "set_member_role($1, $2, 'admin')", [lab, gus]))).toBe("BL822");
  });
});

describe("removing a member", () => {
  it("removes only the membership: what they made stays, under their name", async () => {
    await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/Lab')", [lab]);
    await asRole(db, as(fay), () => rows(db, "create_protocol($1, 'protocol', 'Fay''s lysis', '1. Thaw on ice.')", [lab]));
    const person = await db.query("insert into people (lab_id, display_name, member_user_id) values ($1, 'Fay', $2) returning id", [lab, fay]);
    await call(dee, "remove_member($1, $2)", [lab, fay]);
    expect((await roles())[fay]).toBeUndefined();
    expect((await db.query("select author from protocol_versions v join protocols p on p.id = v.protocol_id where p.lab_id = $1", [lab])).rows).toEqual([{ author: fay }]);
    expect((await db.query("select display_name, member_user_id from people where id = $1", [person.rows[0]?.id])).rows).toEqual([{ display_name: "Fay", member_user_id: null }]);
    expect(await audited("member.remove")).toBe(1);
    // Gone from the lab: Fay reads nothing of it any more.
    expect(await asRole(db, as(fay), () => rows(db, "lab_members($1)", [lab]))).toEqual([]);
  });

  it("keeps the last admin, and goes only through remove_member", async () => {
    expect(await code(() => call(dee, "remove_member($1, $2)", [lab, dee]))).toBe("BL821");
    expect(await code(() => call(eli, "remove_member($1, $2)", [lab, dee]))).toBe("42501");
    expect(await code(() => asRole(db, as(dee), () => db.query("delete from members where lab_id = $1 and user_id = $2", [lab, eli])))).toBe("42501");
    expect((await roles())[eli]).toBe("member");
  });

  it("lets an admin leave once someone else is an admin", async () => {
    await call(dee, "set_member_role($1, $2, 'admin')", [lab, eli]);
    await call(dee, "remove_member($1, $2)", [lab, dee]);
    expect(await roles()).toEqual({ [eli]: "admin" });
  });
});

describe("the monthly AI limit", () => {
  const budget = (userId: UserId) =>
    asRole(db, as(userId), async () => z.array(z.object({ cap_usd: z.coerce.number() })).parse(await rows(db, "ai_budget($1)", [lab]))[0]?.cap_usd);

  it("is set by an admin, rounded to cents, audited, and read by every member", async () => {
    await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [lab, fay]);
    expect(await budget(fay)).toBe(25);
    await call(eli, "set_ai_cap($1, 12.345)", [lab]);
    expect(await budget(fay)).toBe(12.35);
    expect(await audited("lab.ai_cap")).toBe(1);
  });

  it("refuses members, other labs and amounts outside $0 to $1000", async () => {
    expect(await code(() => call(fay, "set_ai_cap($1, 100)", [lab]))).toBe("42501");
    expect(await code(() => call(gus, "set_ai_cap($1, 100)", [lab]))).toBe("42501");
    expect(await code(() => call(eli, "set_ai_cap($1, -1)", [lab]))).toBe("22023");
    expect(await code(() => call(eli, "set_ai_cap($1, 1000.01)", [lab]))).toBe("22023");
    expect(await budget(fay)).toBe(12.35);
  });
});
