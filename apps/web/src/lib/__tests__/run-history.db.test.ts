import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CheckSpecs, SaveChecksRequest, saveChecksArgs } from "../checks";
import { CreateLabResult } from "../domain";
import { CheckId, LabId, ProtocolId, ProtocolVersionId, Sha256 } from "../ids";
import { SavedVersionRows } from "../protocols";
import { assembleHistory, HISTORY_RESULT_COLUMNS, OpenFlagRows, ResultRows, VersionRows } from "../run-history";
import { assembleRuns, ExperimentRows, LABEL_RUN_COLUMNS, LabelRunRows, LOCATION_RUN_COLUMNS, LocationRunRows } from "../runs";

// A check's run history and files as runs, read with the store's own selects as a member under
// RLS against the real migrations: three Bradford runs of one experiment, the first checked
// under version 2 (at least 0.95) and flagged, the second labeled failed, the third checked
// under version 3 (at least 0.98); and what another lab sees.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const rosa = "00000000-0000-4000-8000-0000000003a1";
const sam = "00000000-0000-4000-8000-0000000003a2";
const CURVE = CheckId.parse("0f8f2c1e-0001-4a4e-8c55-0c3c1a7a03a1");
const run1 = Sha256.parse("a1".repeat(32));
const run2 = Sha256.parse("a2".repeat(32));
const run3 = Sha256.parse("a3".repeat(32));
const shas = [run1, run2, run3];

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

async function rows(sql: string, params: unknown[]): Promise<unknown> {
  const res = await db.query(`with r as (${sql}) select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from r`, params);
  return z.object({ rows: z.unknown() }).parse(res.rows[0]).rows;
}

let labA: LabId;
let labB: LabId;
let protocol: ProtocolId;
const versions: ProtocolVersionId[] = [];
const curve = (min: number) => ({ id: CURVE, name: "Standard curve fit", kind: "curve_fit", sheet: null, unit: null, range: { kind: "at_least", min }, x: null, y: null });

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'rosa.runs@lab.test'), ($2, 'sam.runs@lab.test') on conflict do nothing", [rosa, sam]);
  labA = LabId.parse(CreateLabResult.parse((await asUser(rosa, () => db.query("select create_lab('Runs lab A') as id"))).rows[0]?.id));
  labB = LabId.parse(CreateLabResult.parse((await asUser(sam, () => db.query("select create_lab('Runs lab B') as id"))).rows[0]?.id));
  const created = await asUser(rosa, () => db.query("select * from create_protocol($1, 'protocol', 'Bradford assay', 'Read at 595 nm.')", [labA]));
  protocol = ProtocolId.parse(created.rows[0]?.protocol_id);
  let base = ProtocolVersionId.parse(created.rows[0]?.version_id);
  for (const min of [0.95, 0.98]) {
    const a = saveChecksArgs(protocol, SaveChecksRequest.parse({ baseVersionId: base, checks: CheckSpecs.parse([curve(min)]), note: null }));
    const saved = SavedVersionRows.parse(await asUser(rosa, () => rows("select * from save_checks($1, $2, $3, $4)", [a.p_protocol_id, a.p_base_version_id, JSON.stringify(a.p_checks), a.p_note])));
    base = saved.versionId;
    versions.push(saved.versionId);
  }
  const source = await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/x') returning id", [labA]);
  const experiment = await db.query("insert into experiments (lab_id, name) values ($1, 'P450 purification') returning id", [labA]);
  for (const [i, sha] of shas.entries()) {
    const name = `Bradford_2026-11-0${i + 2}.xlsx`;
    await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 7210, 'application/zip', 'spreadsheet') on conflict do nothing", [sha]);
    await db.query(
      `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
       values ($1, $2, $3, $4, $3, 7210, '2026-11-10T12:00:00Z', 'r1', $5, 'indexed')`,
      [labA, source.rows[0]?.id, name, `/Bradford/${name}`, sha],
    );
    await db.query("insert into data_tables (lab_id, sha256, state, parser_version, storage_key) values ($1, $2, 'ready', 3, $3)", [labA, sha, `${labA}/tables/${sha}.json`]);
    await db.query(
      `insert into labels (lab_id, sha256, status, clean_name, date, experiment_id, confidence, source, outcome)
       values ($1, $2, 'accepted', $3, $4, $5, 0.9, 'rules', $6)`,
      [labA, sha, `Bradford run ${i + 1}`, `2026-11-0${i + 2}`, experiment.rows[0]?.id, i === 1 ? "failed" : "worked"],
    );
  }
  // What the worker writes, outside RLS: run 1 flagged under version 2, runs 2 and 3 under 3.
  const [v2, v3] = versions;
  const result = (sha: Sha256, version: ProtocolVersionId | undefined, outcome: string, observed: number) =>
    db.query(
      `insert into check_results (lab_id, sha256, protocol_id, protocol_version_id, check_id, kind, outcome, observed)
       values ($1, $2, $3, $4, $5, 'curve_fit', $6, $7)`,
      [labA, sha, protocol, version, CURVE, outcome, observed],
    );
  await db.query(
    `insert into flags (lab_id, sha256, protocol_id, protocol_version_id, check_id, kind, observed, expected,
       source_sheet, source_columns, source_rows, evidence)
     values ($1, $2, $3, $4, $5, 'curve_fit', 0.884, '{"kind":"at_least","min":0.95}', 'Standards', '{A,E}', '{[0,6)}', $6)`,
    [labA, run1, protocol, v2, CURVE, "b".repeat(64)],
  );
  await result(run1, v2, "flagged", 0.884);
  await result(run2, v3, "passed", 0.982);
  await result(run3, v3, "passed", 0.996);
});

afterAll(async () => {
  await db.query("delete from labs where id = any($1)", [[labA, labB]]);
  await db.end();
});

// The store's reads, in its own words (lib/run-store.ts), as one member.
async function readHistory(userId: string, lab: LabId) {
  return asUser(userId, async () => {
    const results = ResultRows.parse(await rows(`select ${HISTORY_RESULT_COLUMNS} from check_results where lab_id = $1 and protocol_id = $2 and check_id = $3`, [lab, protocol, CURVE]));
    const ids = [...new Set(results.map((r) => r.protocol_version_id))];
    const versionRows = VersionRows.parse(await rows("select id, version, expected_values from protocol_versions where protocol_id = $1 and id = any($2)", [protocol, ids]));
    const wanted = results.map((r) => r.sha256);
    const locations = LocationRunRows.parse(await rows(`select ${LOCATION_RUN_COLUMNS} from file_locations where lab_id = $1 and sha256 = any($2) and deleted_at is null order by modified_at desc`, [lab, wanted]));
    const labels = LabelRunRows.parse(await rows(`select ${LABEL_RUN_COLUMNS} from labels where lab_id = $1 and sha256 = any($2)`, [lab, wanted]));
    const experiments = ExperimentRows.parse(await rows("select id, name from experiments where lab_id = $1", [lab]));
    const flags = OpenFlagRows.parse(await rows("select id, sha256 from flags where lab_id = $1 and protocol_id = $2 and check_id = $3 and cleared_at is null", [lab, protocol, CURVE]));
    const runs = assembleRuns(wanted, locations, labels, experiments);
    const current = CheckSpecs.parse([curve(0.98)]);
    return assembleHistory({ protocol: { id: protocol, title: "Bradford assay" }, current, checkId: CURVE, results, versions: versionRows, runs, flags });
  });
}

describe("a check's run history", () => {
  it("holds each run to the range of the version it was checked against, oldest first", async () => {
    const history = await readHistory(rosa, labA);
    expect(history?.runs.map((r) => [r.run.name, r.run.date, r.observed, r.result, r.range, r.version])).toEqual([
      ["Bradford run 1", "2026-11-02", 0.884, "flagged", { kind: "at_least", min: 0.95 }, 2],
      ["Bradford run 2", "2026-11-03", 0.982, "passed", { kind: "at_least", min: 0.98 }, 3],
      ["Bradford run 3", "2026-11-04", 0.996, "passed", { kind: "at_least", min: 0.98 }, 3],
    ]);
  });

  it("links the flagged run to its open flag and keeps the failed run's outcome", async () => {
    const history = await readHistory(rosa, labA);
    expect(history?.runs[0]?.flagId).not.toBeNull();
    expect(history?.runs.slice(1).map((r) => r.flagId)).toEqual([null, null]);
    expect(history?.runs.map((r) => r.run.outcome)).toEqual(["worked", "failed", "worked"]);
    expect(history?.runs.map((r) => r.run.experiment)).toEqual(["P450 purification", "P450 purification", "P450 purification"]);
  });

  it("leaves out a run whose file left the lab", async () => {
    await db.query("update file_locations set deleted_at = now() where lab_id = $1 and sha256 = $2", [labA, run3]);
    try {
      const history = await readHistory(rosa, labA);
      expect(history?.runs.map((r) => r.run.name)).toEqual(["Bradford run 1", "Bradford run 2"]);
    } finally {
      await db.query("update file_locations set deleted_at = null where lab_id = $1 and sha256 = $2", [labA, run3]);
    }
  });

  it("shows another lab nothing", async () => {
    const history = await readHistory(sam, labA);
    expect(history?.runs).toEqual([]);
  });
});
