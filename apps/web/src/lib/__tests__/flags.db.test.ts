import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CheckSpecs, ExpectedValuesRows, SaveChecksRequest, saveChecksArgs } from "../checks";
import { AuditAction, CreateLabResult } from "../domain";
import { FileCheckRows, FlagMarkRows, FlagQueueCount, FlagRows, ReviewRequest, reviewArgs, ReviewRows, UsefulnessRows, usefulnessKey } from "../flags";
import { CheckId, FlagId, LabId, ProtocolId, ProtocolVersionId, Sha256 } from "../ids";
import { SavedVersionRows } from "../protocols";

// Checks and flags through the web app's calls and parsers, against the real migrations as the
// `authenticated` role with RLS: saving checks, the worker's flag as a member reads it, answering
// it, the answer rate admins see, what another lab sees, and a flag with no source refused.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const rosa = "00000000-0000-4000-8000-0000000002f1";
const sam = "00000000-0000-4000-8000-0000000002f2";
const mo = "00000000-0000-4000-8000-0000000000f3";
const sha = Sha256.parse("e".repeat(63) + "1");
const CURVE = "0f8f2c1e-0001-4a4e-8c55-0c3c1a7a00f1";

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

// Rows as PostgREST serializes them.
async function rows(sql: string, params: unknown[]): Promise<unknown> {
  const res = await db.query(`with r as (${sql}) select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from r`, params);
  return z.object({ rows: z.unknown() }).parse(res.rows[0]).rows;
}

let labA: LabId;
let labB: LabId;
let protocol: ProtocolId;
let version: ProtocolVersionId;
let flagId: FlagId;

const curve = { id: CURVE, name: "Standard curve fit", kind: "curve_fit", sheet: null, unit: null, range: { kind: "at_least", min: 0.98 }, x: null, y: null };

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'rosa.flags@lab.test'), ($2, 'sam.flags@lab.test'), ($3, 'mo@lab.test') on conflict do nothing", [rosa, sam, mo]);
  labA = LabId.parse(CreateLabResult.parse((await asUser(rosa, () => db.query("select create_lab('Flags lab A') as id"))).rows[0]?.id));
  labB = LabId.parse(CreateLabResult.parse((await asUser(sam, () => db.query("select create_lab('Flags lab B') as id"))).rows[0]?.id));
  await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [labA, mo]);
  // What the worker writes for a processed Bradford workbook.
  await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 7210, 'application/zip', 'spreadsheet') on conflict do nothing", [sha]);
  const source = await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/x') returning id", [labA]);
  await db.query(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, 'b.xlsx', '/Bradford/Bradford_2026-11-04.xlsx', 'Bradford_2026-11-04.xlsx', 7210, now(), 'r1', $3, 'indexed')`,
    [labA, source.rows[0]?.id, sha],
  );
  await db.query(
    "insert into data_tables (lab_id, sha256, state, parser_version, storage_key) values ($1, $2, 'ready', 1, $3)",
    [labA, sha, `${labA}/tables/${sha}.json`],
  );
});

afterAll(async () => {
  await db.query("delete from labs where id = any($1)", [[labA, labB]]);
  await db.end();
});

describe("checks on a protocol", () => {
  it("save as a new version that keeps the text, and read back as CheckSpecs", async () => {
    const created = await asUser(mo, () => db.query("select * from create_protocol($1, 'protocol', 'Bradford assay', 'Read at 595 nm.')", [labA]));
    protocol = ProtocolId.parse(created.rows[0]?.protocol_id);
    const base = ProtocolVersionId.parse(created.rows[0]?.version_id);
    const req = SaveChecksRequest.parse({ baseVersionId: base, checks: CheckSpecs.parse([curve]), note: "First checks" });
    const a = saveChecksArgs(protocol, req);
    const saved = SavedVersionRows.parse(
      await asUser(mo, () => rows("select * from save_checks($1, $2, $3, $4)", [a.p_protocol_id, a.p_base_version_id, JSON.stringify(a.p_checks), a.p_note])),
    );
    expect(saved.version).toBe(2);
    version = saved.versionId;
    const checks = ExpectedValuesRows.parse(await asUser(mo, () => rows("select expected_values from protocol_versions where id = $1", [version])));
    expect(checks).toEqual(CheckSpecs.parse([curve]));
    const body = await asUser(mo, () => db.query("select body, note from protocol_versions where id = $1", [version]));
    expect(body.rows[0]).toEqual({ body: "Read at 595 nm.", note: "First checks" });
    // A stale base is BL101, which the route answers as stale.
    await expect(asUser(mo, () => db.query("select save_checks($1, $2, '[]', null)", [protocol, base]))).rejects.toMatchObject({ code: "BL101" });
  });
});

describe("a flag the worker raised", () => {
  it("reads as a Flag with its source, for members of its lab only", async () => {
    // The worker writes as the table owner, outside RLS.
    const raised = await db.query(
      `insert into flags (lab_id, sha256, protocol_id, protocol_version_id, check_id, kind, observed, expected,
         source_sheet, source_columns, source_rows, evidence)
       values ($1, $2, $3, $4, $5, 'curve_fit', 0.8762, '{"kind":"at_least","min":0.98}', 'Standards', '{A,E}', '{[0,6)}', $6) returning id`,
      [labA, sha, protocol, version, CURVE, "a".repeat(64)],
    );
    flagId = FlagId.parse(raised.rows[0]?.id);
    await db.query(
      `insert into check_results (lab_id, sha256, protocol_id, protocol_version_id, check_id, kind, outcome, observed)
       values ($1, $2, $3, $4, $5, 'curve_fit', 'flagged', 0.8762)`,
      [labA, sha, protocol, version, CURVE],
    );

    const [flag] = FlagRows.parse(await asUser(mo, () => rows("select * from lab_flags($1)", [labA])));
    expect(flag).toMatchObject({
      id: flagId,
      protocolTitle: "Bradford assay",
      protocolVersion: 2,
      checkName: "Standard curve fit",
      observed: 0.8762,
      expected: { kind: "at_least", min: 0.98 },
      source: { sha256: sha, sheet: "Standards", columns: ["A", "E"], rows: [[0, 5]] },
      control: null,
      state: { kind: "open" },
      answer: null,
    });
    expect(flag?.source.file?.location.originalName).toBe("Bradford_2026-11-04.xlsx");

    const [check] = FileCheckRows.parse(await asUser(mo, () => rows("select * from file_checks($1, $2)", [labA, sha])));
    expect(check?.outcome).toEqual({ kind: "flagged", observed: 0.8762, flagId });
    expect(FlagMarkRows.parse(await asUser(mo, () => rows("select * from file_flag_marks($1, $2)", [labA, [sha]])))).toEqual([{ sha256: sha, flags: 1 }]);
    expect(FlagQueueCount.parse((await asUser(mo, () => db.query("select flag_queue_count($1) as n", [labA]))).rows[0]?.n)).toBe(1);

    expect(await asUser(sam, () => rows("select * from lab_flags($1)", [labA]))).toEqual([]);
    expect(await asUser(sam, () => rows("select * from flags", []))).toEqual([]);
    expect(await asUser(sam, () => rows("select * from check_results", []))).toEqual([]);
  });

  it("takes an answer, audited, and only the answer", async () => {
    const a = reviewArgs(flagId, ReviewRequest.parse({ review: "wrong", note: " The curve is fine past 750. " }));
    const answer = ReviewRows.parse(await asUser(mo, () => rows("select * from review_flag($1, $2, $3)", [a.p_flag_id, a.p_review, a.p_note])));
    expect(answer).toMatchObject({ review: "wrong", note: "The curve is fine past 750.", by: mo });
    await expect(asUser(sam, () => db.query("select * from review_flag($1, 'useful', null)", [flagId]))).rejects.toMatchObject({ code: "BL107" });
    await expect(asUser(mo, () => db.query("update flags set observed = 0.99 where id = $1", [flagId]))).rejects.toMatchObject({ code: "42501" });
    // "Wrong" takes the amber off the file's row, and the queue no longer waits on it.
    expect(await asUser(mo, () => rows("select * from file_flag_marks($1, $2)", [labA, [sha]]))).toEqual([]);
    expect((await asUser(mo, () => db.query("select flag_queue_count($1) as n", [labA]))).rows[0]?.n).toBe(0);

    const audit = z
      .array(z.object({ action: AuditAction, actor: z.string(), target: z.string() }))
      .parse(await rows("select action, actor, target from audit_log where lab_id = $1 and action in ('check.save', 'flag.review') order by at, id", [labA]));
    expect(audit).toEqual([
      { action: "check.save", actor: mo, target: `${protocol} v2` },
      { action: "flag.review", actor: mo, target: `${flagId} wrong` },
    ]);
  });

  it("feeds the answer rate admins see", async () => {
    const rates = UsefulnessRows.parse(await asUser(rosa, () => rows("select * from check_usefulness($1)", [labA])));
    expect(rates[usefulnessKey(protocol, CheckId.parse(CURVE))]).toEqual({ flags: 1, useful: 0, wrong: 1, knownIssue: 0 });
    await expect(asUser(mo, () => db.query("select * from check_usefulness($1)", [labA]))).rejects.toMatchObject({ code: "42501" });
  });

  it("can't exist without its version, its file and its cells", async () => {
    const insert = (columns: string, values: string, params: unknown[]) =>
      db.query(`insert into flags (lab_id, sha256, protocol_id, check_id, kind, observed, expected, evidence, ${columns}) values ($1, $2, $3, $4, 'curve_fit', 0.5, '{"kind":"at_least","min":0.98}', '${"b".repeat(64)}', ${values})`, [
        labA,
        sha,
        protocol,
        CURVE,
        ...params,
      ]);
    await expect(insert("source_sheet, source_columns, source_rows", "'Standards', '{A,E}', '{[0,6)}'", [])).rejects.toMatchObject({ code: "23502" });
    await expect(insert("protocol_version_id, source_columns, source_rows", "$5, '{A,E}', '{[0,6)}'", [version])).rejects.toMatchObject({ code: "23502" });
    await expect(insert("protocol_version_id, source_sheet, source_columns, source_rows", "$5, 'Standards', '{A,E}', '{}'", [version])).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insert("protocol_version_id, source_sheet, source_columns, source_rows", "$5, 'Standards', '{}', '{[0,6)}'", [version])).rejects.toMatchObject({
      code: "23514",
    });
  });
});
