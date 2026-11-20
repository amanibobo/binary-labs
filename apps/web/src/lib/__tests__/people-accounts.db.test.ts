import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { LabId, PersonId, RunId, Sha256 } from "../ids";
import { PeopleAccountsJson } from "../people-accounts";
import { RunJson } from "../run-record";

// People linked to accounts (0042) against the real migrations: joining with a matching name,
// "This is me", an admin's link and unlink, and a yes that never passes to the next account.
// Also set_run_status asking before it removes a failure type.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ada = "00000000-0000-4000-8000-0000000f9801";
const priyaUser = "00000000-0000-4000-8000-0000000f9802";
const ben = "00000000-0000-4000-8000-0000000f9803";
const cy = "00000000-0000-4000-8000-0000000f9804";
const sam = "00000000-0000-4000-8000-0000000f9805";
const jo = "00000000-0000-4000-8000-0000000f9806";
const kim = "00000000-0000-4000-8000-0000000f9807";
const sha = (n: number) => Sha256.parse(`a8${n.toString(16).padStart(62, "0")}`);

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

const claim = (userId: string, person: string) => call(userId, "claim_person($1)", [person]);
const link = (userId: string, person: string, target: string) => call(userId, "link_person($1, $2)", [person, target]);
const unlink = (userId: string, person: string) => call(userId, "unlink_person($1)", [person]).then((v) => z.number().parse(v));
const peopleOf = (userId: string, labId: LabId) => call(userId, "(select coalesce(jsonb_agg(p), '[]') from lab_people($1) p)", [labId]).then((v) => PeopleAccountsJson.parse(v));
const linkedTo = async (person: string) => z.string().nullable().parse((await owner("select member_user_id::text as v from people where id = $1", [person])).rows[0]?.v);
const addPerson = async (labId: LabId, name: string, userId: string | null = null) =>
  PersonId.parse((await owner("insert into people (lab_id, display_name, member_user_id) values ($1, $2, $3) returning id", [labId, name, userId])).rows[0]?.id);
const join = (labId: LabId, userId: string) => owner("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [labId, userId]);
const audits = async (labId: LabId, action: string) =>
  z
    .array(z.object({ actor: z.string().nullable(), target: z.string() }))
    .parse((await owner("select actor::text, target from audit_log where lab_id = $1 and action::text = $2 order by id", [labId, action])).rows);
const blocks = async (runId: RunId) => z.array(z.string()).parse((await owner("select run_export_blocks($1) as v", [runId])).rows[0]?.v);

let lab: LabId;
let otherLab: LabId;
let source: string;
let files = 0;

async function failedRun(title: string): Promise<RunId> {
  files += 1;
  const s = sha(files);
  await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/csv', 'spreadsheet') on conflict do nothing", [s]);
  await owner(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, $3, '/' || $3, $3, 10, now(), 'r', $4, 'indexed')`,
    [lab, source, `f${files}.csv`, s],
  );
  return RunJson.parse(await call(ada, "create_run($1, $2, $3::jsonb)", [lab, [s], JSON.stringify({ title, status: "failed" })])).id;
}
const confirmBy = (userId: string, run: RunId, person: string) =>
  call(userId, "confirm_cause($1, 'Old buffer', $2, 'pi_opinion', null, null, null, null)", [run, person]).then((r) => RunJson.parse(r));
const attest = (userId: string, run: RunId) => call(userId, "attest_cause($1)", [run]).then((r) => RunJson.parse(r));

beforeAll(async () => {
  await db.connect();
  await owner(
    `insert into auth.users (id, email, raw_user_meta_data) values
       ($1, 'ada@people.test', null), ($2, 'priya.nair@people.test', null), ($3, 'ben@people.test', null),
       ($4, 'cy@people.test', null), ($5, 'sam.lee@people.test', null), ($6, 'jo@people.test', '{"full_name": "Jo Park"}'),
       ($7, 'kim@people.test', null)`,
    [ada, priyaUser, ben, cy, sam, jo, kim],
  );
  lab = LabId.parse(CreateLabResult.parse(await call(ada, "create_lab('People lab')", [])));
  otherLab = LabId.parse(CreateLabResult.parse(await call(cy, "create_lab('Other people lab')", [])));
  source = z.string().parse((await owner("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/p') returning id", [lab])).rows[0]?.id);
});

afterAll(async () => {
  await db.end();
});

describe("joining a lab", () => {
  it("links the one unlinked row with the member's name, spaces, case and punctuation aside, and logs it", async () => {
    const row = await addPerson(lab, "Priya Nair");
    await addPerson(lab, "Priya");
    await join(lab, priyaUser);
    expect(await linkedTo(row)).toBe(priyaUser);
    expect(await audits(lab, "person.link")).toEqual([{ actor: null, target: `${row}:${priyaUser}` }]);
  });

  it("uses the account's own name when it has one", async () => {
    const row = await addPerson(lab, "Jo Park");
    await join(lab, jo);
    expect(await linkedTo(row)).toBe(jo);
  });

  it("links nothing when two rows have the name, when the only one is someone else's, or when none does", async () => {
    const a = await addPerson(lab, "Sam Lee");
    const b = await addPerson(lab, "sam-lee");
    await join(lab, sam);
    expect([await linkedTo(a), await linkedTo(b)]).toEqual([null, null]);

    await addPerson(lab, "Ben", ada);
    await join(lab, ben);
    expect(z.array(z.object({ id: z.string() })).parse((await owner("select id from people where member_user_id = $1", [ben])).rows)).toEqual([]);

    const before = Number((await owner("select count(*) from people where lab_id = $1", [lab])).rows[0]?.count);
    await join(lab, kim);
    expect(Number((await owner("select count(*) from people where lab_id = $1", [lab])).rows[0]?.count)).toBe(before);

    const dots = "00000000-0000-4000-8000-0000000f980b";
    await owner("insert into auth.users (id, email) values ($1, '..@people.test')", [dots]);
    const dashes = await addPerson(lab, "--");
    await join(lab, dots);
    expect(await linkedTo(dashes)).toBeNull();
  });
});

describe("This is me", () => {
  it("links a member to a row nobody has, logged as their own, and saying it again changes nothing", async () => {
    const row = await addPerson(lab, "Ben Okoro");
    await claim(ben, row);
    expect(await linkedTo(row)).toBe(ben);
    await claim(ben, row);
    expect((await audits(lab, "person.link")).filter((a) => a.target === `${row}:${ben}`)).toEqual([{ actor: ben, target: `${row}:${ben}` }]);
  });

  it("refuses a row someone else has, a second row for the same member, and a row that isn't there", async () => {
    const mine = z.string().parse((await owner("select id::text from people where member_user_id = $1", [priyaUser])).rows[0]?.id);
    expect(await codeOf(claim(sam, mine))).toBe("BL982");
    expect(await codeOf(claim(ben, await addPerson(lab, "Someone new")))).toBe("BL983");
    expect(await codeOf(claim(sam, "00000000-0000-4000-8000-00000000dead"))).toBe("BL981");
  });

  it("lets one of two claims at once through when they'd make the same member two people", async () => {
    const racer = "00000000-0000-4000-8000-0000000f980a";
    await owner("insert into auth.users (id, email) values ($1, 'racer@people.test')", [racer]);
    await join(lab, racer);
    const [a, b] = [await addPerson(lab, "Race one"), await addPerson(lab, "Race two")];
    const second = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
    await second.connect();
    try {
      const claims = { sub: racer };
      await second.query("begin");
      await second.query("set local role authenticated");
      await second.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await second.query("select claim_person($1)", [a]);
      const late = codeOf(claim(racer, b));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await second.query("commit");
      expect(await late).toBe("BL983");
    } finally {
      await second.end();
    }
    expect([await linkedTo(a), await linkedTo(b)]).toEqual([racer, null]);
  });

  it("is only for the person's own lab, and not for someone signed out", async () => {
    const row = await addPerson(lab, "Lab only");
    expect(await codeOf(claim(cy, row))).toBe("42501");
    expect(await codeOf(asRole("anon", null, () => db.query("select claim_person($1)", [row])))).toBe("42501");
    expect(await linkedTo(row)).toBeNull();
  });
});

describe("an admin's link and unlink", () => {
  it("links a row to a member of the lab, logged as the admin's", async () => {
    const row = await addPerson(lab, "Samuel Lee");
    await link(ada, row, sam);
    expect(await linkedTo(row)).toBe(sam);
    expect((await audits(lab, "person.link")).at(-1)).toEqual({ actor: ada, target: `${row}:${sam}` });
  });

  it("is an admin's only, and only to a member of this lab who isn't someone else already", async () => {
    const row = await addPerson(lab, "Kim Tran");
    expect(await codeOf(link(ben, row, kim))).toBe("42501");
    expect(await codeOf(link(ada, row, cy))).toBe("BL984");
    expect(await codeOf(link(ada, row, ben))).toBe("BL983");
    await link(ada, row, kim);
    expect(await codeOf(link(ada, row, ada))).toBe("BL982");
    expect(await codeOf(unlink(ben, row))).toBe("42501");
    expect(await linkedTo(row)).toBe(kim);
  });

  it("unlinks a row, logged, and unlinking it again changes nothing", async () => {
    const kimRow = z.string().parse((await owner("select id::text from people where member_user_id = $1", [kim])).rows[0]?.id);
    expect(await unlink(ada, kimRow)).toBe(0);
    expect(await linkedTo(kimRow)).toBeNull();
    expect((await audits(lab, "person.unlink")).at(-1)).toEqual({ actor: ada, target: `${kimRow}:${kim}` });
    expect(await unlink(ada, kimRow)).toBe(0);
    expect((await audits(lab, "person.unlink")).filter((a) => a.target.startsWith(kimRow))).toHaveLength(1);
  });

  it("isn't callable through the helpers that skip the checks", async () => {
    const row = await addPerson(lab, "Helper target");
    expect(await codeOf(call(kim, "put_person_link($1, $2, $3)", [row, lab, kim]))).toBe("42501");
    expect(await codeOf(call(kim, "member_person($1)", [row]))).toBe("42501");
    expect(await codeOf(call(kim, "(select link_checked(p, $2) from people p where p.id = $1)", [row, kim]))).toBe("42501");
    expect(await linkedTo(row)).toBeNull();
  });
});

describe("a yes stays with the account that gave it", () => {
  it("unlinking takes back the yeses on causes the row confirmed, so the run can't be exported, and a new link doesn't bring them back", async () => {
    const row = await addPerson(lab, "Dana Cruz");
    await link(ada, row, kim);
    const run = await failedRun("Western, first try");
    const other = await failedRun("Western, second try");
    await confirmBy(ada, run, row);
    await confirmBy(ada, other, row);
    await attest(kim, run);
    expect((await attest(kim, other)).failure.confirmerAttestedAt).not.toBeNull();
    expect(await blocks(run)).not.toContain("not_attested");
    expect((await peopleOf(ada, lab)).find((p) => p.id === row)).toMatchObject({ yeses: 2, userId: kim, email: "kim@people.test", you: false });

    expect(await unlink(ada, row)).toBe(2);
    const after = RunJson.parse(await call(ada, "run_json($1)", [run]));
    expect(after.failure).toMatchObject({ confirmedCause: "Old buffer", confirmerAttestedAt: null });
    expect(await blocks(run)).toContain("not_attested");
    expect(z.array(z.object({ via: z.string(), actor: z.string() })).parse((await owner(
      "select via::text, actor::text from run_log where run_id = $1 and after ? 'confirmer_attested_at' and after ->> 'confirmer_attested_at' is null", [run],
    )).rows)).toEqual([{ via: "trigger", actor: ada }]);

    await link(ada, row, await freeMember());
    expect((await peopleOf(ada, lab)).find((p) => p.id === row)?.yeses).toBe(0);
    expect(await blocks(run)).toContain("not_attested");
  });

  it("a member leaving takes back their yeses too", async () => {
    const leaver = "00000000-0000-4000-8000-0000000f9809";
    await owner("insert into auth.users (id, email) values ($1, 'lee.ward@people.test')", [leaver]);
    const row = await addPerson(lab, "Lee Ward");
    await join(lab, leaver);
    expect(await linkedTo(row)).toBe(leaver);
    const run = await failedRun("Leaver's run");
    await confirmBy(leaver, run, row);
    expect(RunJson.parse(await call(ada, "run_json($1)", [run])).failure.confirmerAttestedAt).not.toBeNull();
    await call(ada, "remove_member($1, $2)", [lab, leaver]);
    expect(await linkedTo(row)).toBeNull();
    expect(RunJson.parse(await call(ada, "run_json($1)", [run])).failure.confirmerAttestedAt).toBeNull();
  });
});

async function freeMember(): Promise<string> {
  const user = "00000000-0000-4000-8000-0000000f9808";
  await owner("insert into auth.users (id, email) values ($1, 'new.hire@people.test') on conflict do nothing", [user]);
  await join(lab, user);
  return user;
}

describe("lab_people", () => {
  it("lists the lab's People with each one's account and the caller's own row, and nothing to another lab", async () => {
    const rows = await peopleOf(priyaUser, lab);
    expect(rows.find((p) => p.name === "Priya Nair")).toMatchObject({ you: true, email: "priya.nair@people.test", userId: priyaUser, yeses: 0 });
    expect(rows.find((p) => p.name === "Priya")).toMatchObject({ you: false, email: null, userId: null });
    expect(rows.filter((p) => p.you)).toHaveLength(1);
    expect(await peopleOf(cy, lab)).toEqual([]);
  });
});

describe("set_run_status and a failure type with no cause", () => {
  it("asks before leaving failed removes a failure type, keeps it moving to odd, and removes it when told", async () => {
    const run = await failedRun("Typed only");
    await call(ada, "set_failure_type($1, 1::smallint, 'tech.western', null, null)", [run]);
    expect(await codeOf(call(ada, "set_run_status($1, 'worked')", [run]))).toBe("BL906");
    expect(await codeOf(call(ada, "set_run_status($1, null)", [run]))).toBe("BL906");
    expect(RunJson.parse(await call(ada, "set_run_status($1, 'odd')", [run])).failure.technique).toBe("tech.western");
    const cleared = RunJson.parse(await call(ada, "set_run_status($1, 'worked', true)", [run]));
    expect(cleared.status).toBe("worked");
    expect(cleared.failure).toMatchObject({ taxonomyVersion: null, technique: null });
  });

  it("still saves straight away when there is nothing to remove", async () => {
    const run = await failedRun("Nothing written");
    expect(RunJson.parse(await call(ada, "set_run_status($1, 'worked')", [run])).status).toBe("worked");
  });
});

describe("deleting the lab", () => {
  it("still works with a linked confirmer who said yes", async () => {
    const benRow = z.string().parse((await owner("select id::text from people where member_user_id = $1", [ben])).rows[0]?.id);
    const run = await failedRun("Ben's own yes");
    expect((await confirmBy(ben, run, benRow)).failure.confirmerAttestedAt).not.toBeNull();
    await owner("delete from labs where id = $1", [lab]);
    for (const table of ["people", "runs", "run_log", "members"]) {
      expect(Number((await owner(`select count(*) from ${table} where lab_id = $1`, [lab])).rows[0]?.count)).toBe(0);
    }
    expect(Number((await owner("select count(*) from members where lab_id = $1", [otherLab])).rows[0]?.count)).toBe(1);
  });
});
