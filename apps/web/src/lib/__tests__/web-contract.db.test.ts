import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateLabResult, LabMemberRows, ProgressRows, SearchFilesRows, type SearchParams } from "../domain";
import { LabId } from "../ids";
import { searchFilesArgs, toVectorLiteral } from "../search";
import { decryptToken, fromPgBytea, toPgBytea } from "../token-crypto";

// Runs the web app's RPC arguments and parsers against the real migrations, as
// the `authenticated` role with RLS, serializing rows with to_jsonb the way PostgREST does.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const alice = "00000000-0000-4000-8000-00000000000a";
const bob = "00000000-0000-4000-8000-00000000000b";
const carol = "00000000-0000-4000-8000-00000000000c";
const vector = JSON.parse(readFileSync(join(__dirname, "../../../../../db/test/token_vector.json"), "utf8"));
const sha = (c: string) => c.repeat(64);
const unit = (i: number) => toVectorLiteral(Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0)));

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

async function search(userId: string, labId: LabId, params: SearchParams, embedding: number[] | null = null) {
  const a = searchFilesArgs({ labId, params, embedding });
  const raw = await asUser(userId, () =>
    rpcJson("search_files($1, $2, $3::vector, $4::file_kind[], $5, $6::timestamptz, $7::timestamptz, $8)", [
      a.p_lab_id,
      a.p_query,
      a.p_query_embedding,
      a.p_file_kinds,
      a.p_path_prefix,
      a.p_modified_from,
      a.p_modified_to,
      a.p_limit,
    ]),
  );
  return SearchFilesRows.parse(raw);
}

let labA: LabId;
let labB: LabId;
let sourceA = "";

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'alice@lab.edu'), ($2, 'bob@other.edu'), ($3, 'carol@lab.edu')", [
    alice,
    bob,
    carol,
  ]);
  labA = CreateLabResult.parse(
    await asUser(alice, async () => (await db.query("select create_lab('Okafor Lab') as id")).rows[0]?.id),
  );
  labB = CreateLabResult.parse(await asUser(bob, async () => (await db.query("select create_lab('Other Lab') as id")).rows[0]?.id));
  await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [labA, carol]);

  // The web app inserts the source through PostgREST with the token as "\x…" text.
  sourceA = await asUser(alice, async () => {
    await db.query(
      "insert into sources (lab_id, kind, account_label, token_ciphertext) values ($1, 'dropbox', 'alice@lab.edu', $2::bytea)",
      [labA, toPgBytea(Buffer.from(vector.blob_hex, "hex"))],
    );
    return "";
  });
  sourceA = z.string().parse((await db.query("select id from sources where lab_id = $1", [labA])).rows[0]?.id);

  const loc = (id: string, s: string, path: string, modified: string, state = "indexed", error: string | null = null) =>
    db.query(
      `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state, index_error)
       values ($1, $2, $3, $4, regexp_replace($4, '^.*/', ''), 10, $5, 'rev', $6, $7, $8)`,
      [labA, sourceA, id, path, modified, s, state, error],
    );
  await db.query(
    `insert into blobs (sha256, size, mime, file_kind) values
       ($1, 10, 'image/jpeg', 'image'), ($2, 10, 'application/pdf', 'pdf'), ($3, 10, 'text/plain', 'text')`,
    [sha("a"), sha("b"), sha("c")],
  );
  await loc("id:1", sha("a"), "/Lab/Gels/IMG_4821.jpg", "2026-10-14T23:30:00Z");
  await loc("id:2", sha("b"), "/Lab/Protocols/P450 purification.pdf", "2026-09-01T10:00:00Z");
  await loc("id:3", sha("b"), "/Lab/Old/P450 purification copy.pdf", "2026-08-01T10:00:00Z");
  await loc("id:4", sha("c"), "/Lab/Notes/zymogram.txt", "2026-10-20T10:00:00Z", "failed", "unreadable");
  await db.query(
    `insert into chunks (lab_id, sha256, ord, text, embedding, embed_model) values
       ($1, $2, 0, 'Lab Gels IMG_4821.jpg', $4::vector, 'm'),
       ($1, $3, 0, 'Lab Protocols P450 purification.pdf', $5::vector, 'm'),
       ($1, $3, 1, 'Purify P450 on the SEC column, then run gels for batch 3.', $6::vector, 'm')`,
    [labA, sha("a"), sha("b"), unit(0), unit(1), unit(2)],
  );
  await db.query("insert into previews (lab_id, sha256, storage_key, width, height) values ($1, $2, $3, 64, 64)", [
    labA,
    sha("a"),
    `${labA}/${sha("a")}.webp`,
  ]);
});

afterAll(async () => {
  await db.end();
});

describe("search_files through the web app's args and parser", () => {
  it("finds files by words, merges duplicates and keeps both locations", async () => {
    const hits = await search(alice, labA, { q: "P450 purification" });
    expect(hits.map((h) => h.sha256)).toEqual([sha("b")]);
    expect(hits[0]?.matchedBy).toEqual(["words"]);
    expect(hits[0]?.locations.map((l) => l.path)).toEqual([
      "/Lab/Protocols/P450 purification.pdf",
      "/Lab/Old/P450 purification copy.pdf",
    ]);
    expect(hits[0]?.snippet).toContain("SEC column");
  });

  it("adds meaning matches when an embedding is passed", async () => {
    const hits = await search(alice, labA, { q: "electrophoresis photo" }, Array.from({ length: 1024 }, (_, j) => (j === 0 ? 1 : 0)));
    expect(hits[0]?.sha256).toBe(sha("a"));
    expect(hits[0]?.matchedBy).toEqual(["meaning"]);
    expect(hits[0]?.hasPreview).toBe(true);
  });

  it("applies kind, folder and an inclusive end date", async () => {
    expect((await search(alice, labA, { q: "lab", kind: "pdf" })).map((h) => h.sha256)).toEqual([sha("b")]);
    expect((await search(alice, labA, { q: "lab", prefix: "/lab/gels" })).map((h) => h.sha256)).toEqual([sha("a")]);
    // IMG_4821 was modified late on Oct 14 (UTC); "to Oct 14" must include it.
    expect((await search(alice, labA, { q: "img", to: "2026-10-14" })).map((h) => h.sha256)).toEqual([sha("a")]);
    expect(await search(alice, labA, { q: "img", from: "2026-10-15" })).toEqual([]);
  });

  it("never shows failed files or another lab's files", async () => {
    expect(await search(alice, labA, { q: "zymogram" })).toEqual([]);
    expect(await search(bob, labA, { q: "P450" })).toEqual([]);
    expect(await search(alice, labB, { q: "P450" })).toEqual([]);
  });
});

describe("other RPCs the web app parses", () => {
  it("source_progress counts by state", async () => {
    const rows = ProgressRows.parse(await asUser(carol, () => rpcJson("source_progress($1)", [labA])));
    expect(rows).toEqual([{ source_id: sourceA, pending: 0, indexed: 3, failed: 1 }]);
  });

  it("lab_members lists members with emails, and nothing for outsiders", async () => {
    const members = LabMemberRows.parse(await asUser(carol, () => rpcJson("lab_members($1)", [labA])));
    expect(members.map((m) => [m.email, m.role])).toEqual([
      ["alice@lab.edu", "admin"],
      ["carol@lab.edu", "member"],
    ]);
    expect(LabMemberRows.parse(await asUser(bob, () => rpcJson("lab_members($1)", [labA])))).toEqual([]);
  });
});

describe("source token and writes", () => {
  it("stores the token so the service role reads back the exact vector", async () => {
    const res = await db.query("select token_ciphertext::text as t from sources where id = $1", [sourceA]);
    const text = z.string().parse(res.rows[0]?.t);
    const key = Buffer.from(vector.key_b64, "base64");
    expect(decryptToken({ key, blob: fromPgBytea(text) })).toBe(vector.plaintext);
  });

  it("hides the token column from signed-in users", async () => {
    await expect(asUser(alice, () => db.query("select token_ciphertext from sources"))).rejects.toThrow(/permission denied/);
  });

  it("lets an admin set the folder and request a scan, but not a member", async () => {
    const update = "update sources set root_path = '/Lab', scan_requested_at = now() where id = $1 and lab_id = $2 returning id";
    expect((await asUser(alice, () => db.query(update, [sourceA, labA]))).rowCount).toBe(1);
    expect((await asUser(carol, () => db.query(update, [sourceA, labA]))).rowCount).toBe(0);
  });

  it("accepts audit rows only from the acting member", async () => {
    const insert = "insert into audit_log (lab_id, actor, action, target) values ($1, $2, 'search', 'p450')";
    await asUser(carol, () => db.query(insert, [labA, carol]));
    await expect(asUser(carol, () => db.query(insert, [labA, alice]))).rejects.toThrow(/row-level security/);
    await expect(asUser(bob, () => db.query(insert, [labA, bob]))).rejects.toThrow(/row-level security/);
  });
});
