import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { LabId, PersonId, RunId, Sha256 } from "../ids";
import { ConfirmerChoicesJson, FailureListJson } from "../run-failure";
import { RunJson, RunRowsJson, type RunRecord } from "../run-record";

// The failure record's functions (0035) against the real migrations: as members of the lab,
// as the named confirmer, as a member of another lab, as someone in no lab and signed out.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ada = "00000000-0000-4000-8000-0000000f6001";
const ben = "00000000-0000-4000-8000-0000000f6002";
const cy = "00000000-0000-4000-8000-0000000f6003";
const dee = "00000000-0000-4000-8000-0000000f6004";
const sha = (n: number) => Sha256.parse(`a7${n.toString(16).padStart(62, "0")}`);

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
const asUser = <T>(userId: string, fn: () => Promise<T>) => asRole("authenticated", userId, fn);
const one = z.object({ v: z.unknown() });
const call = (userId: string, sql: string, params: unknown[]) =>
  asUser(userId, async () => one.parse((await db.query(`select ${sql} as v`, params)).rows[0]).v);
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);
const owner = (sql: string, params: unknown[] = []) => db.query(sql, params);

let lab: LabId;
let otherLab: LabId;
let priya: PersonId;
let benRow: PersonId;
let stranger: PersonId;
let failed: RunRecord;
let retry: RunRecord;
let worked: RunRecord;
let unmarked: RunRecord;
let theirs: RunRecord;

async function addFile(labId: LabId, sourceId: string, s: Sha256, name: string) {
  await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/csv', 'spreadsheet') on conflict do nothing", [s]);
  await owner(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, $3, '/' || $3, $3, 10, now(), 'r', $4, 'indexed')`,
    [labId, sourceId, name, s],
  );
}

const create = (userId: string, labId: LabId, shas: Sha256[], title: string, status: string | null) =>
  call(userId, "create_run($1, $2, $3::jsonb)", [labId, shas, JSON.stringify({ title, status })]).then((r) => RunJson.parse(r));
const suspect = (userId: string, id: RunId, cause: string | null) => call(userId, "set_suspected_cause($1, $2)", [id, cause]).then((r) => RunJson.parse(r));

type Confirm = { cause: string | null; person?: string | null; method?: string | null; note?: string | null; at?: string | null; run?: string | null; sha?: string | null };
const confirm = (userId: string, id: RunId, c: Confirm) =>
  call(userId, "confirm_cause($1, $2, $3, $4, $5, $6, $7, $8)", [id, c.cause, c.person ?? null, c.method ?? null, c.note ?? null, c.at ?? null, c.run ?? null, c.sha ?? null]).then((r) =>
    RunJson.parse(r),
  );
const attest = (userId: string, id: RunId) => call(userId, "attest_cause($1)", [id]).then((r) => RunJson.parse(r));
const setType = (userId: string, id: RunId, version: number | null, technique: string | null, step: string | null, cause: string | null) =>
  call(userId, "set_failure_type($1, $2, $3, $4, $5)", [id, version, technique, step, cause]).then((r) => RunJson.parse(r));
const list = (userId: string, filter: Record<string, string>) =>
  call(userId, "(select coalesce(jsonb_agg(r), '[]') from lab_runs($1, $2::jsonb) r)", [lab, JSON.stringify(filter)]).then((r) => RunRowsJson.parse(r).map((row) => row.title));

beforeAll(async () => {
  await db.connect();
  await owner("insert into auth.users (id, email) values ($1, 'ada@failure.test'), ($2, 'ben@failure.test'), ($3, 'cy@failure.test'), ($4, 'dee@failure.test')", [ada, ben, cy, dee]);
  lab = LabId.parse(CreateLabResult.parse(await call(ada, "create_lab('Failure lab')", [])));
  otherLab = LabId.parse(CreateLabResult.parse(await call(cy, "create_lab('Other failure lab')", [])));
  await owner("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, ben]);
  priya = PersonId.parse((await owner("insert into people (lab_id, display_name) values ($1, 'Priya') returning id", [lab])).rows[0]?.id);
  benRow = PersonId.parse((await owner("insert into people (lab_id, display_name, member_user_id) values ($1, 'Ben', $2) returning id", [lab, ben])).rows[0]?.id);
  stranger = PersonId.parse((await owner("insert into people (lab_id, display_name) values ($1, 'Stranger') returning id", [otherLab])).rows[0]?.id);
  const source = (await owner("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/f') returning id", [lab])).rows[0]?.id;
  const otherSource = (await owner("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/g') returning id", [otherLab])).rows[0]?.id;
  for (let n = 1; n <= 6; n += 1) await addFile(lab, source, sha(n), `gel${n}.tif`);
  await addFile(otherLab, otherSource, sha(9), "theirs.tif");
  failed = await create(ada, lab, [sha(1), sha(2)], "Western, first try", "failed");
  retry = await create(ada, lab, [sha(3)], "Western, second try", "worked");
  worked = await create(ada, lab, [sha(4)], "PCR that worked", "worked");
  unmarked = await create(ada, lab, [sha(5)], "Nobody said", null);
  theirs = await create(cy, otherLab, [sha(9)], "Their run", "failed");
});

afterAll(async () => {
  await db.end();
});

describe("set_suspected_cause", () => {
  it("lets any member write what they think went wrong, trimmed, and take it back", async () => {
    const run = await suspect(ben, failed.id, "  Old transfer buffer  ");
    expect(run.failure).toMatchObject({ suspectedCause: "Old transfer buffer", suspectedBy: ben });
    expect((await suspect(ada, failed.id, null)).failure).toMatchObject({ suspectedCause: null, suspectedBy: null });
    expect((await suspect(ada, failed.id, "Old transfer buffer")).failure.suspectedBy).toBe(ada);
  });

  it("only goes on a run that failed or was odd, with no hole for a run nobody marked", async () => {
    expect(await codeOf(suspect(ada, worked.id, "Nothing"))).toBe("BL913");
    expect(await codeOf(suspect(ada, unmarked.id, "Nothing"))).toBe("BL913");
    expect((await suspect(ada, unmarked.id, null)).failure.suspectedCause).toBeNull();
  });

  it("refuses an empty or too long cause", async () => {
    expect(await codeOf(suspect(ada, failed.id, "   "))).toBe("BL917");
    expect(await codeOf(suspect(ada, failed.id, "x".repeat(4001)))).toBe("BL917");
    expect((await suspect(ada, failed.id, "x".repeat(4000))).failure.suspectedCause).toHaveLength(4000);
    await suspect(ada, failed.id, "Old transfer buffer");
  });

  it("refuses another lab's member, someone in no lab, a signed-out caller and a missing run", async () => {
    expect(await codeOf(suspect(cy, failed.id, "Mine"))).toBe("42501");
    expect(await codeOf(suspect(dee, failed.id, "Mine"))).toBe("42501");
    expect(await codeOf(asRole("anon", null, () => db.query("select set_suspected_cause($1, 'x')", [failed.id])))).toBe("42501");
    expect(await codeOf(suspect(ada, RunId.parse("00000000-0000-4000-8000-00000000dead"), "x"))).toBe("BL907");
  });
});

describe("confirm_cause", () => {
  it("saves a confirmed cause with a named confirmer, how, when, and who typed it in", async () => {
    const run = await confirm(ada, failed.id, { cause: " Transfer buffer was a month old ", person: priya, method: "repeat", run: retry.id, note: " Fresh buffer fixed it ", at: "2026-11-05T14:00:00Z" });
    expect(run.failure).toMatchObject({
      confirmedCause: "Transfer buffer was a month old",
      confirmedBy: { id: priya, name: "Priya" },
      confirmMethod: "repeat",
      confirmRun: { id: retry.id, title: "Western, second try" },
      confirmSha256: null,
      confirmNote: "Fresh buffer fixed it",
      confirmRecordedBy: ada,
      confirmerAttestedAt: null,
      suspectedCause: "Old transfer buffer",
    });
    expect(Date.parse(run.failure.confirmedAt ?? "")).toBe(Date.parse("2026-11-05T14:00:00Z"));
  });

  it("dates it now when no time is given, and refuses a time in the future", async () => {
    const before = Date.now();
    const run = await confirm(ada, failed.id, { cause: "Transfer buffer was a month old", person: priya, method: "pi_opinion" });
    expect(Date.parse(run.failure.confirmedAt ?? "")).toBeGreaterThanOrEqual(before - 1000);
    expect(await codeOf(confirm(ada, failed.id, { cause: "x", person: priya, method: "pi_opinion", at: new Date(Date.now() + 3600_000).toISOString() }))).toBe("BL915");
  });

  it("takes a control only as one of this run's own files", async () => {
    const run = await confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "control", sha: sha(2) });
    expect(run.failure).toMatchObject({ confirmMethod: "control", confirmSha256: sha(2), confirmRun: null });
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "control", sha: sha(3) }))).toBe("BL914");
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "control" }))).toBe("BL914");
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "control", sha: sha(2), run: retry.id }))).toBe("BL914");
  });

  it("takes a repeat with or without a run of this lab, never itself, and the PI's opinion with neither", async () => {
    expect((await confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "repeat" })).failure.confirmRun).toBeNull();
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "repeat", run: failed.id }))).toBe("BL914");
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "repeat", run: theirs.id }))).toBe("BL914");
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "repeat", sha: sha(1) }))).toBe("BL914");
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "pi_opinion", sha: sha(1) }))).toBe("BL914");
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "pi_opinion", run: retry.id }))).toBe("BL914");
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: priya, method: null }))).toBe("BL914");
  });

  it("names only one of this lab's People", async () => {
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: stranger, method: "pi_opinion" }))).toBe("BL911");
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: "00000000-0000-4000-8000-00000000beef", method: "pi_opinion" }))).toBe("BL911");
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: null, method: "pi_opinion" }))).toBe("BL911");
  });

  it("only goes on a run that failed or was odd, and refuses empty or too long words", async () => {
    expect(await codeOf(confirm(ada, worked.id, { cause: "Buffer", person: priya, method: "pi_opinion" }))).toBe("BL913");
    expect(await codeOf(confirm(ada, unmarked.id, { cause: "Buffer", person: priya, method: "pi_opinion" }))).toBe("BL913");
    expect(await codeOf(confirm(ada, failed.id, { cause: "  ", person: priya, method: "pi_opinion" }))).toBe("BL917");
    expect(await codeOf(confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "pi_opinion", note: "n".repeat(2001) }))).toBe("BL917");
  });

  it("refuses another lab's member and someone in no lab", async () => {
    expect(await codeOf(confirm(cy, failed.id, { cause: "Buffer", person: priya, method: "pi_opinion" }))).toBe("42501");
    expect(await codeOf(confirm(dee, failed.id, { cause: "Buffer", person: priya, method: "pi_opinion" }))).toBe("42501");
  });

  it("takes the confirmation back with a null cause, from any status", async () => {
    await confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "pi_opinion" });
    const run = await confirm(ben, failed.id, { cause: null });
    expect(run.failure).toMatchObject({ confirmedCause: null, confirmedBy: null, confirmMethod: null, confirmedAt: null, confirmRecordedBy: null, confirmerAttestedAt: null });
    expect(run.failure.suspectedCause).toBe("Old transfer buffer");
  });

  it("turns a shared run's sharing off, and the log keeps each change", async () => {
    await owner("update runs set share = true where id = $1", [failed.id]);
    const run = await confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "pi_opinion", at: "2026-11-06T09:00:00Z" });
    expect(run.share).toBe(false);
    const edits = (await owner("select after from run_log where run_id = $1 and action = 'run.edit' order by id desc limit 1", [failed.id])).rows;
    expect(edits[0]?.after).toMatchObject({ confirmed_cause: "Buffer", confirmed_by: priya, confirm_method: "pi_opinion" });
  });
});

describe("attest_cause", () => {
  it("lets only the named confirmer's own account say yes", async () => {
    await confirm(ada, failed.id, { cause: "Buffer", person: priya, method: "pi_opinion" });
    // Priya has no account: nobody can say yes for her.
    expect(await codeOf(attest(ada, failed.id))).toBe("BL912");
    expect(await codeOf(attest(ben, failed.id))).toBe("BL912");
    await confirm(ada, failed.id, { cause: "Buffer", person: benRow, method: "pi_opinion" });
    expect(await codeOf(attest(ada, failed.id))).toBe("BL912");
    expect(await codeOf(attest(cy, failed.id))).toBe("42501");
    const yes = await attest(ben, failed.id);
    expect(yes.failure.confirmerAttestedAt).not.toBeNull();
    expect((await attest(ben, failed.id)).failure.confirmerAttestedAt).toBe(yes.failure.confirmerAttestedAt);
  });

  it("refuses a run with nothing confirmed", async () => {
    expect(await codeOf(attest(ben, retry.id))).toBe("BL912");
  });

  it("counts the confirmer's own entry as their yes, and waits for it again after anyone else changes it", async () => {
    const own = await confirm(ben, failed.id, { cause: "Buffer was old", person: benRow, method: "pi_opinion" });
    expect(own.failure.confirmerAttestedAt).not.toBeNull();
    const same = await confirm(ada, failed.id, { cause: "Buffer was old", person: benRow, method: "pi_opinion", at: own.failure.confirmedAt });
    expect(same.failure.confirmerAttestedAt).toBe(own.failure.confirmerAttestedAt);
    const changed = await confirm(ada, failed.id, { cause: "Buffer was very old", person: benRow, method: "pi_opinion", at: own.failure.confirmedAt });
    expect(changed.failure).toMatchObject({ confirmerAttestedAt: null, confirmRecordedBy: ada });
  });

  it("blocks export again when another member changes the cause, the method or the confirmer of an attested cause", async () => {
    const blocks = async () => z.array(z.string()).parse((await owner("select run_export_blocks($1) as b", [failed.id])).rows[0]?.b);
    const own = await confirm(ben, failed.id, { cause: "Buffer was old", person: benRow, method: "pi_opinion" });
    const at = own.failure.confirmedAt;
    expect(await blocks()).not.toContain("not_attested");
    await confirm(ada, failed.id, { cause: "Buffer was older", person: benRow, method: "pi_opinion", at });
    expect(await blocks()).toContain("not_attested");
    await attest(ben, failed.id);
    expect(await blocks()).not.toContain("not_attested");
    await confirm(ada, failed.id, { cause: "Buffer was older", person: benRow, method: "repeat", at });
    expect(await blocks()).toContain("not_attested");
    await attest(ben, failed.id);
    await confirm(ada, failed.id, { cause: "Buffer was older", person: priya, method: "repeat", at });
    expect(await blocks()).toContain("not_attested");
  });

  it("takes the yes back with the confirmation", async () => {
    expect((await confirm(ben, failed.id, { cause: "Buffer was old", person: benRow, method: "pi_opinion" })).failure.confirmerAttestedAt).not.toBeNull();
    expect((await confirm(ada, failed.id, { cause: null })).failure.confirmerAttestedAt).toBeNull();
  });
});

describe("set_failure_type", () => {
  it("codes the run against a version of the list, each part optional, and clears it", async () => {
    const run = await setType(ben, failed.id, 1, "tech.western", "step.reagent_prep", "cause.reagent");
    expect(run.failure).toMatchObject({ taxonomyVersion: 1, technique: "tech.western", failedStep: "step.reagent_prep", causeCategory: "cause.reagent" });
    expect((await setType(ben, failed.id, 1, "tech.western", null, null)).failure).toMatchObject({ technique: "tech.western", failedStep: null, causeCategory: null });
    expect((await setType(ben, failed.id, null, null, null, null)).failure).toMatchObject({ taxonomyVersion: null, technique: null });
  });

  it("refuses a term that isn't on the list, in the wrong place, or of a version that doesn't exist", async () => {
    expect(await codeOf(setType(ada, failed.id, 1, "tech.cooking", null, null))).toBe("BL916");
    expect(await codeOf(setType(ada, failed.id, 1, null, "cause.reagent", null))).toBe("BL916");
    expect(await codeOf(setType(ada, failed.id, 1, null, null, "step.setup"))).toBe("BL916");
    expect(await codeOf(setType(ada, failed.id, 1, "step.setup", null, null))).toBe("BL916");
    expect(await codeOf(setType(ada, failed.id, 2, "tech.pcr", null, null))).toBe("BL916");
    expect(await codeOf(setType(ada, failed.id, null, "tech.pcr", null, null))).toBe("BL916");
  });

  it("only goes on a run that failed or was odd, for members of its lab", async () => {
    expect(await codeOf(setType(ada, worked.id, 1, "tech.pcr", null, null))).toBe("BL913");
    expect(await codeOf(setType(ada, unmarked.id, 1, "tech.pcr", null, null))).toBe("BL913");
    expect(await codeOf(setType(cy, failed.id, 1, "tech.pcr", null, null))).toBe("42501");
  });
});

describe("done when", () => {
  it("saves a failed run with a confirmed cause and a named confirmer, and finds it by failure type", async () => {
    const odd = await create(ben, lab, [sha(6)], "Odd PCR bands", "odd");
    await setType(ben, odd.id, 1, "tech.pcr", "step.setup", "cause.contamination");
    await confirm(ada, failed.id, { cause: "Transfer buffer was a month old", person: priya, method: "repeat", run: retry.id, at: "2026-11-05T14:00:00Z" });
    await setType(ada, failed.id, 1, "tech.western", "step.reagent_prep", "cause.reagent");
    expect(await list(ben, { technique: "tech.western" })).toEqual(["Western, first try"]);
    expect(await list(ben, { step: "step.setup" })).toEqual(["Odd PCR bands"]);
    expect(await list(ben, { cause: "cause.reagent" })).toEqual(["Western, first try"]);
    expect(await list(ben, { technique: "tech.pcr", cause: "cause.reagent" })).toEqual([]);
    expect(await list(ben, { status: "failed", technique: "tech.western", step: "step.reagent_prep", cause: "cause.reagent" })).toEqual(["Western, first try"]);
    const row = RunRowsJson.parse(await call(ben, "(select coalesce(jsonb_agg(r), '[]') from lab_runs($1, $2::jsonb) r)", [lab, JSON.stringify({ cause: "cause.reagent" })]))[0];
    expect(row).toMatchObject({ confirmed: true, technique: "tech.western", failedStep: "step.reagent_prep", causeCategory: "cause.reagent" });
  });
});

describe("leaving failed or odd", () => {
  it("keeps the causes from failed to odd, asks before worked, and the log keeps what was cleared", async () => {
    expect((await call(ada, "set_run_status($1, 'odd')", [failed.id]).then((r) => RunJson.parse(r))).failure.confirmedCause).toBe("Transfer buffer was a month old");
    expect(await codeOf(call(ada, "set_run_status($1, 'worked')", [failed.id]))).toBe("BL906");
    expect(await codeOf(call(ada, "set_run_status($1, null)", [failed.id]))).toBe("BL906");
    const cleared = RunJson.parse(await call(ada, "set_run_status($1, 'worked', true)", [failed.id]));
    expect(cleared.failure).toEqual({
      suspectedCause: null, suspectedBy: null, confirmedCause: null, confirmedBy: null, confirmMethod: null, confirmNote: null, confirmRun: null,
      confirmSha256: null, confirmedAt: null, confirmRecordedBy: null, confirmerAttestedAt: null, taxonomyVersion: null, technique: null, failedStep: null, causeCategory: null,
    });
    const last = (await owner("select before from run_log where run_id = $1 and action = 'run.edit' order by id desc limit 1", [failed.id])).rows[0]?.before;
    expect(last).toMatchObject({ suspected_cause: "Old transfer buffer", confirmed_cause: "Transfer buffer was a month old", confirmed_by: priya, technique: "tech.western" });
    await call(ada, "set_run_status($1, 'failed')", [failed.id]);
  });
});

describe("confirmer_choices", () => {
  it("lists the run's lab's People, marking the caller's own row and who can sign in", async () => {
    const choices = ConfirmerChoicesJson.parse(await call(ben, "(select coalesce(jsonb_agg(r), '[]') from confirmer_choices($1) r)", [failed.id]));
    expect(choices).toEqual([
      { id: benRow, name: "Ben", you: true, account: true },
      { id: priya, name: "Priya", you: false, account: false },
    ]);
    expect(ConfirmerChoicesJson.parse(await call(ada, "(select coalesce(jsonb_agg(r), '[]') from confirmer_choices($1) r)", [failed.id])).map((c) => c.you)).toEqual([false, false]);
  });

  it("shows nothing to another lab's member or someone in no lab, and nothing to a signed-out caller", async () => {
    expect(await call(cy, "(select coalesce(jsonb_agg(r), '[]') from confirmer_choices($1) r)", [failed.id])).toEqual([]);
    expect(await call(dee, "(select coalesce(jsonb_agg(r), '[]') from confirmer_choices($1) r)", [failed.id])).toEqual([]);
    expect(await codeOf(asRole("anon", null, () => db.query("select confirmer_choices($1)", [failed.id])))).toBe("42501");
  });
});

describe("failure_list", () => {
  it("is the newest version, a draft, in picker order, for anyone signed in", async () => {
    const list = FailureListJson.parse(await call(dee, "failure_list()", []));
    expect(list).toMatchObject({ version: 1, signedOffAt: null, signedOffBy: null });
    expect(list.terms).toHaveLength(44);
    expect(list.terms[0]).toEqual({ version: 1, code: "cause.reagent", label: "A reagent was bad", hint: "Expired, degraded, wrong lot", position: 1 });
    expect(list.terms.filter((t) => t.code.startsWith("tech.")).map((t) => t.position)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(await codeOf(asRole("anon", null, () => db.query("select failure_list()")))).toBe("42501");
  });
});

describe("grants", () => {
  it("gives members the failure functions and keeps the text helper the owner's", async () => {
    const grants = z.array(z.object({ name: z.string(), member: z.boolean(), anon: z.boolean() })).parse(
      (
        await owner(
          `select p.proname as name, has_function_privilege('authenticated', p.oid, 'execute') as member, has_function_privilege('anon', p.oid, 'execute') as anon
           from pg_proc p where p.proname = any ($1) order by 1`,
          [["attest_cause", "confirm_cause", "confirmer_choices", "failure_list", "failure_text", "set_failure_type", "set_suspected_cause"]],
        )
      ).rows,
    );
    expect(grants.filter((g) => g.anon)).toEqual([]);
    expect(grants.filter((g) => !g.member).map((g) => g.name)).toEqual(["failure_text"]);
    expect(grants).toHaveLength(7);
  });
});
