import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditAction, CreateLabResult } from "../domain";
import type { LabId } from "../ids";
import { deletionFailure, LAB_DELETION_COLUMNS, LabDeletionRow, ProtocolExportRows, protocolsMarkdown } from "../lab-deletion";

// Deleting a lab and disconnecting Dropbox through the web app's calls and parsers, against
// the real migrations as the `authenticated` role with RLS. The worker's side is in
// workers/tests/test_deletion.py.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const admin = "00000000-0000-4000-8000-0000000000e1";
const member = "00000000-0000-4000-8000-0000000000e2";

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
  const res = await db.query(`select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from ${sql} r`, params);
  return z.object({ rows: z.unknown() }).parse(res.rows[0]).rows;
}

async function dbError(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    return z.object({ code: z.string().optional(), message: z.string() }).parse(err);
  }
  throw new Error("expected the call to fail");
}

const SOURCE_COLUMNS = "id, root_path, account_label, scan_requested_at, scan_started_at, scan_finished_at, scan_error, disconnected_at";

let lab: LabId;
let source: string;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'pi@okafor.edu'), ($2, 'student@okafor.edu')", [admin, member]);
  lab = CreateLabResult.parse(await asUser(admin, async () => (await db.query("select create_lab('Okafor Lab') as id")).rows[0]?.id));
  await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, member]);
  source = z.string().parse(
    (
      await db.query(
        "insert into sources (lab_id, kind, root_path, account_label, token_ciphertext) values ($1, 'dropbox', '/Lab', 'pi@okafor.edu', '\\x00') returning id",
        [lab],
      )
    ).rows[0]?.id,
  );
});

afterAll(async () => {
  await db.end();
});

describe("disconnecting Dropbox", () => {
  it("is refused to a member, and leaves the source readable to members once an admin does it", async () => {
    const refused = await dbError(() => asUser(member, () => db.query("select disconnect_source($1)", [source])));
    expect(refused.code).toBe("42501");

    await asUser(admin, () => db.query("select disconnect_source($1)", [source]));

    const seen = z
      .array(z.object({ disconnected_at: z.string().nullable(), root_path: z.string().nullable() }))
      .parse(await asUser(member, () => rows(`(select ${SOURCE_COLUMNS} from sources where id = $1)`, [source])));
    expect(seen).toEqual([{ disconnected_at: expect.any(String), root_path: "/Lab" }]);
    const audit = z
      .array(z.object({ action: AuditAction, actor: z.string() }))
      .parse(await rows("(select action, actor from audit_log where lab_id = $1 and action = 'source.disconnect')", [lab]));
    expect(audit).toEqual([{ action: "source.disconnect", actor: admin }]);
  });
});

describe("exporting protocols before deleting", () => {
  it("returns the current version of every live page, and the Markdown carries each one", async () => {
    await asUser(member, async () => {
      const lysis = z.string().parse((await db.query("select (create_protocol($1, 'protocol', 'Lysis', 'Thaw on ice.')).protocol_id as id", [lab])).rows[0]?.id);
      const v1 = z.string().parse((await db.query("select current_version_id as v from protocols where id = $1", [lysis])).rows[0]?.v);
      await db.query("select save_protocol($1, $2, 'Lysis', 'Thaw on ice for 30 min.', null)", [lysis, v1]);
      await db.query("select create_protocol($1, 'tutorial', 'Using the plate reader', 'Turn it on.')", [lab]);
    });
    await asUser(admin, async () => {
      const old = z.string().parse((await db.query("select (create_protocol($1, 'protocol', 'Old gel', 'Retired.')).protocol_id as id", [lab])).rows[0]?.id);
      await db.query("select archive_protocol($1)", [old]);
    });

    const pages = ProtocolExportRows.parse(await asUser(member, () => rows("protocol_export($1)", [lab])));
    expect(pages.map((p) => [p.kind, p.title, p.version, p.body])).toEqual([
      ["protocol", "Lysis", 2, "Thaw on ice for 30 min."],
      ["tutorial", "Using the plate reader", 1, "Turn it on."],
    ]);
    const md = protocolsMarkdown({ labName: "Okafor Lab", demo: false, exportedAt: new Date("2026-11-04T12:00:00Z"), pages });
    expect(md).toContain("Thaw on ice for 30 min.");
    expect(md).not.toContain("Retired.");

    const outsider = ProtocolExportRows.parse(await asUser("00000000-0000-4000-8000-0000000000e9", () => rows("protocol_export($1)", [lab])));
    expect(outsider).toEqual([]);
  });
});

describe("requesting deletion", () => {
  it("refuses a member and a wrong name, then hides the lab and leaves the requester a pending record", async () => {
    const asMember = await dbError(() => asUser(member, () => db.query("select request_lab_deletion($1, 'Okafor Lab')", [lab])));
    expect(deletionFailure(asMember)).toEqual({ kind: "error", message: "Only an admin can delete the lab." });
    const wrongName = await dbError(() => asUser(admin, () => db.query("select request_lab_deletion($1, 'okafor lab')", [lab])));
    expect(deletionFailure(wrongName)).toEqual({ kind: "wrong_name" });

    await asUser(admin, () => db.query("select request_lab_deletion($1, $2)", [lab, " Okafor Lab "]));

    for (const user of [admin, member]) {
      const visible = await asUser(user, () => rows("(select l.id from labs l)", []));
      expect(visible).toEqual([]);
    }
    const record = (user: string) =>
      asUser(user, () => rows(`(select ${LAB_DELETION_COLUMNS} from lab_deletions where lab_id = $1)`, [lab]));
    expect(z.array(LabDeletionRow).parse(await record(admin))).toEqual([
      { kind: "pending", labId: lab, requestedAt: expect.any(String) },
    ]);
    expect(await record(member)).toEqual([]);
    const again = await dbError(() => asUser(admin, () => db.query("select request_lab_deletion($1, 'Okafor Lab')", [lab])));
    expect(deletionFailure(again).kind).toBe("error");
  });

  it("reads the worker's finished record as done with its counts", async () => {
    // What bl_worker/deletion.py writes: a count per lab table, plus jobs, blobs, extractions and preview files.
    await db.query(
      `update lab_deletions set completed_at = now(), counts = $2 where lab_id = $1`,
      [
        lab,
        {
          members: 2, sources: 1, file_locations: 40, chunks: 90, previews: 12, labels: 38, corrections: 1, label_rules: 0,
          experiments: 0, people: 0, model_calls: 3, protocols: 3, protocol_versions: 4, protocol_files: 0, audit_log: 9,
          jobs: 0, extractions: 40, blobs: 40, preview_files: 12,
        },
      ],
    );
    const [done] = z
      .array(LabDeletionRow)
      .parse(await asUser(admin, () => rows(`(select ${LAB_DELETION_COLUMNS} from lab_deletions where lab_id = $1)`, [lab])));
    expect(done).toMatchObject({ kind: "done", removed: { files: 40, previews: 12, labels: 38, protocols: 3, members: 2 } });
  });
});
