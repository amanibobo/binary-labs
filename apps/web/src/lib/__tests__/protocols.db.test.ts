import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateLabResult, AuditAction } from "../domain";
import { FolderFilesRows } from "../folders";
import { ProtocolId, Sha256, type LabId } from "../ids";
import {
  CreateProtocolRequest,
  createProtocolArgs,
  HISTORY_COLUMNS,
  HistoryRows,
  protocolFailure,
  ProtocolListRows,
  ProtocolVersionRows,
  SavedVersionRows,
  SaveProtocolRequest,
  saveProtocolArgs,
  SearchProtocolsRows,
} from "../protocols";

// The web app's protocol RPC arguments and parsers against the real migrations, as the
// `authenticated` role with RLS, serializing rows with to_jsonb the way PostgREST does.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const dana = "00000000-0000-4000-8000-0000000000d1";
const eli = "00000000-0000-4000-8000-0000000000d2";
const sha = Sha256.parse("0d".repeat(32));

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

// A database error as supabase-js hands it over: a message and the SQLSTATE as `code`.
async function rpcError(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    return z.object({ code: z.string().optional(), message: z.string() }).parse(err);
  }
  throw new Error("expected the call to fail");
}

let lab: LabId;

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'dana@lab.edu'), ($2, 'eli@lab.edu')", [dana, eli]);
  lab = CreateLabResult.parse(await asUser(dana, async () => (await db.query("select create_lab('Protocol Lab') as id")).rows[0]?.id));
  await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, eli]);
  const source = z
    .string()
    .parse((await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/Lab') returning id", [lab])).rows[0]?.id);
  await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'application/pdf', 'pdf')", [sha]);
  await db.query(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, 'id:p', '/Lab/Protocols/Lysis v2.pdf', 'Lysis v2.pdf', 10, now(), 'rev', $3, 'indexed')`,
    [lab, source, sha],
  );
  await db.query("insert into extractions (sha256, extractor, extractor_version, kind, content) values ($1, 'pdfplumber', 1, 'text', $2)", [
    sha,
    "Lysis buffer\n1. Thaw the pellet on ice.",
  ]);
});

afterAll(async () => {
  await db.end();
});

describe("protocols through the web app's arguments and parsers", () => {
  it("starts a page from a file, saves twice, rejects a stale save and keeps every version", async () => {
    const text = await asUser(eli, async () => (await db.query("select file_text($1, $2) as t", [lab, sha])).rows[0]?.t);
    expect(text).toBe("Lysis buffer\n1. Thaw the pellet on ice.");
    const [start] = FolderFilesRows.parse(await asUser(eli, () => rpcJson("file_hits($1, $2::text[])", [lab, [sha]])));
    expect(start?.locations[0].originalName).toBe("Lysis v2.pdf");

    const create = CreateProtocolRequest.parse({ kind: "protocol", title: "Lysis", body: z.string().parse(text), note: null, fromSha256: sha });
    const a = createProtocolArgs(lab, create);
    const created = SavedVersionRows.parse(
      await asUser(eli, () =>
        rpcJson("create_protocol($1, $2::protocol_kind, $3, $4, $5, $6)", [a.p_lab_id, a.p_kind, a.p_title, a.p_body, a.p_note, a.p_file_sha256]),
      ),
    );
    expect(created.version).toBe(1);
    const id = ProtocolId.parse(created.protocolId);

    const save = (base: string, body: string, note: string | null) => {
      const s = saveProtocolArgs(id, SaveProtocolRequest.parse({ baseVersionId: base, title: "Lysis", body, note }));
      return asUser(eli, () =>
        rpcJson("save_protocol($1, $2, $3, $4, $5)", [s.p_protocol_id, s.p_base_version_id, s.p_title, s.p_body, s.p_note]),
      );
    };
    const v2 = SavedVersionRows.parse(await save(created.versionId, "1. Thaw on ice for 20 min.", "longer thaw"));
    const v3 = SavedVersionRows.parse(await save(v2.versionId, "1. Thaw on ice for 30 min.", " "));
    expect([v2.version, v3.version]).toEqual([2, 3]);
    const stale = await rpcError(() => save(v2.versionId, "an edit that started from version 2", null));
    expect(protocolFailure(stale)).toEqual({ kind: "stale" });

    const current = ProtocolVersionRows.parse(await asUser(dana, () => rpcJson("protocol_version($1, $2::int)", [id, null])));
    expect(current).toMatchObject({ version: 3, currentVersion: 3, body: "1. Thaw on ice for 30 min.", note: null, author: eli });
    const first = ProtocolVersionRows.parse(await asUser(dana, () => rpcJson("protocol_version($1, $2::int)", [id, 1])));
    expect(first?.body).toBe("Lysis buffer\n1. Thaw the pellet on ice.");

    const history = HistoryRows.parse(
      await asUser(dana, () =>
        rpcJson(`(select ${HISTORY_COLUMNS} from protocol_versions where protocol_id = $1 order by version desc)`, [id]),
      ),
    );
    expect(history.map((h) => [h.version, h.note])).toEqual([
      [3, null],
      [2, "longer thaw"],
      [1, null],
    ]);

    const list = ProtocolListRows.parse(await asUser(eli, () => rpcJson("protocol_list($1)", [lab])));
    expect(list).toEqual([expect.objectContaining({ id, title: "Lysis", version: 3, author: eli })]);
    const found = SearchProtocolsRows.parse(await asUser(eli, () => rpcJson("search_protocols($1, $2, $3)", [lab, "thaw", 5])));
    expect(found.map((h) => [h.id, h.snippet])).toEqual([[id, "Thaw on ice for 30 min"]]);

    const linked = await asUser(eli, async () => (await db.query("select sha256 from protocol_files where protocol_id = $1", [id])).rows);
    expect(linked).toEqual([{ sha256: sha }]);

    const archiveAsMember = await rpcError(() => asUser(eli, () => db.query("select archive_protocol($1)", [id])));
    expect(protocolFailure(archiveAsMember)).toMatchObject({ status: 403 });
    await asUser(dana, () => db.query("select archive_protocol($1)", [id]));
    expect(ProtocolListRows.parse(await asUser(eli, () => rpcJson("protocol_list($1)", [lab])))).toEqual([]);

    const actions = (await db.query("select action::text as a from audit_log where lab_id = $1 and action::text like 'protocol.%' order by id", [lab])).rows;
    expect(z.array(z.object({ a: AuditAction })).parse(actions).map((r) => r.a)).toEqual([
      "protocol.create",
      "protocol.link_file",
      "protocol.save",
      "protocol.save",
      "protocol.archive",
    ]);
  });
});
