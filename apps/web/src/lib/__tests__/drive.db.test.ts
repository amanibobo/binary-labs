import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { changeLine, DriveFolderRows, FileHistoryRows, parseDriveFiles, versionDetails } from "../drive";
import { LocationId, Sha256, type LabId } from "../ids";

// The drive's RPCs through the web app's parsers, against the real migrations, as the
// `authenticated` role with RLS, serializing rows with to_jsonb the way PostgREST does.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const dana = "00000000-0000-4000-8000-0000000000e1";
const outsider = "00000000-0000-4000-8000-0000000000e2";
const [first, second, photo] = ["e1", "e2", "e3"].map((b) => Sha256.parse(b.repeat(32)));

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

async function rpcJson(sql: string, params: unknown[]): Promise<unknown> {
  const res = await db.query(`select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from ${sql} r`, params);
  return z.object({ rows: z.unknown() }).parse(res.rows[0]).rows;
}

let lab: LabId;
let sheet: LocationId;
let experiment: string;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'dana@drive.edu'), ($2, 'out@drive.edu')", [dana, outsider]);
  lab = CreateLabResult.parse(await asUser(dana, async () => (await db.query("select create_lab('Drive Lab') as id")).rows[0]?.id));
  await asUser(outsider, async () => db.query("select create_lab('Other Lab')"));
  const source = z
    .string()
    .parse((await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/Lab') returning id", [lab])).rows[0]?.id);
  await db.query(
    `insert into blobs (sha256, size, mime, file_kind) values
       ($1, 20, 'text/csv', 'spreadsheet'), ($2, 31, 'text/csv', 'spreadsheet'), ($3, 900, 'image/jpeg', 'image')`,
    [first, second, photo],
  );
  await db.query(
    `insert into extractions (sha256, extractor, extractor_version, kind, content) values
       ($1, 'csv', 1, 'table', $3), ($2, 'csv', 1, 'table', $4)`,
    [first, second, "Well,OD\nA1,0.40", "Well,OD\nA1,0.40\nA2,0.41"],
  );
  const locate = async (externalId: string, path: string, sha: string) =>
    LocationId.parse(
      (
        await db.query(
          `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
           values ($1, $2, $3, $4, regexp_replace($4, '^.*/', ''), 20, '2026-11-01T10:00:00Z', 'r1', $5, 'indexed') returning id`,
          [lab, source, externalId, path, sha],
        )
      ).rows[0]?.id,
    );
  sheet = await locate("id:sheet", "/Lab/P450/plate_export_FINAL.csv", first);
  await locate("id:photo", "/Lab/IMG_4821.jpg", photo);
  experiment = z.string().parse((await db.query("insert into experiments (lab_id, name) values ($1, 'P450 batch 3') returning id", [lab])).rows[0]?.id);
  await db.query(
    `insert into labels (lab_id, sha256, status, clean_name, experiment_id, confidence, source)
     values ($1, $2, 'accepted', 'P450 batch 3 plate read', $3, 0.95, 'human')`,
    [lab, first, experiment],
  );
  // The file is edited and renamed in its folder; the scan writes the new name, then the new content.
  await db.query(
    `update file_locations set path = '/Lab/P450/plate_export_v2.csv', original_name = 'plate_export_v2.csv',
       modified_at = '2026-11-03T09:00:00Z', source_rev = 'r2', sha256 = $2 where id = $1`,
    [sheet, second],
  );
});

afterAll(async () => {
  await db.end();
});

describe("the lab drive through the web app's parsers", () => {
  it("lists folders by experiment, and each file under its clean name with its version count", async () => {
    const folders = DriveFolderRows.parse(await asUser(dana, () => rpcJson("drive_folders($1, 'experiment')", [lab])));
    expect(folders.map((f) => [f.key, f.name, f.files, f.edited])).toEqual([
      ["", null, 1, 0],
      [experiment, "P450 batch 3", 1, 1],
    ]);
    const [file] = parseDriveFiles(await asUser(dana, () => rpcJson("drive_files($1, 'experiment', $2)", [lab, experiment])));
    // The person's name for the file followed it to its edited content.
    expect(file?.hit.label?.cleanName).toBe("P450 batch 3 plate read");
    expect(file?.hit.sha256).toBe(second);
    expect(file?.hit.locations[0].id).toBe(sheet);
    expect(file?.versions).toBe(2);
    const months = DriveFolderRows.parse(await asUser(dana, () => rpcJson("drive_folders($1, 'month')", [lab])));
    expect(months.map((f) => [f.key, f.files])).toEqual([["2026-11", 2]]);
  });

  it("reads a file's history with what each version changed", async () => {
    const versions = FileHistoryRows.parse(await asUser(dana, () => rpcJson("file_history($1, $2)", [lab, sheet])));
    expect(versions.map((v) => [v.number, v.sha256, v.originalName, v.size, v.kept])).toEqual([
      [1, first, "plate_export_FINAL.csv", 20, false],
      [2, second, "plate_export_v2.csv", 31, false],
    ]);
    const texts = await asUser(dana, () =>
      Promise.all(versions.map(async (v) => z.string().nullable().parse((await db.query("select version_text($1, $2) as t", [lab, v.id])).rows[0]?.t))),
    );
    expect(versionDetails(versions, texts).map((d) => changeLine(d.change))).toEqual([
      "The first version Binary read",
      "1 line added · renamed from plate_export_FINAL.csv",
    ]);
  });

  it("shows another lab nothing", async () => {
    expect(await asUser(outsider, () => rpcJson("drive_folders($1, 'experiment')", [lab]))).toEqual([]);
    expect(await asUser(outsider, () => rpcJson("drive_files($1, 'experiment', '')", [lab]))).toEqual([]);
    expect(await asUser(outsider, () => rpcJson("file_history($1, $2)", [lab, sheet]))).toEqual([]);
    const text = await asUser(outsider, async () => (await db.query("select version_text($1, (select id from file_versions limit 1)) as t", [lab])).rows[0]?.t);
    expect(text ?? null).toBeNull();
  });
});
