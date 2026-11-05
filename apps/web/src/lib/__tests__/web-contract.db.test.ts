import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CorrectionRows,
  CreateLabResult,
  ExperimentRows,
  FileLabelRows,
  LabMemberRows,
  NeedsLookCount,
  NeedsLookRows,
  PersonRows,
  ProgressRows,
  SearchFilesRows,
  type FileHit,
  type Label,
  type SearchParams,
} from "../domain";
import { ExperimentId, LabId, Sha256, type CorrectionId } from "../ids";
import { applyEdit, type LabLists } from "../label-edit";
import { correctionFailure, correctLabelArgs, correctRequest } from "../labels";
import { FolderFilesRows, FolderTreeRows } from "../folders";
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

async function correct(userId: string, labId: LabId, sha256: string, label: Label, edit: Parameters<typeof applyEdit>[0]["edit"]) {
  const result = applyEdit({ label, edit, lists });
  if (result.kind !== "changed") throw new Error(`edit did not change the label: ${JSON.stringify(result)}`);
  const a = correctLabelArgs(labId, correctRequest(Sha256.parse(sha256), result.draft));
  const raw = await asUser(userId, () =>
    rpcJson("correct_label($1, $2, $3, $4::date, $5::uuid, $6::uuid, $7, $8::text[])", [
      a.p_lab_id,
      a.p_sha256,
      a.p_clean_name,
      a.p_date,
      a.p_experiment_id,
      a.p_person_id,
      a.p_instrument,
      a.p_tags,
    ]),
  );
  return CorrectionRows.parse(raw);
}

async function undo(userId: string, id: CorrectionId) {
  return CorrectionRows.parse(await asUser(userId, () => rpcJson("undo_correction($1)", [id])));
}

let labA: LabId;
let labB: LabId;
let sourceA = "";
let lists: LabLists;

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

  // Members add experiments and people the way the settings actions do; the worker writes labels as the table owner.
  await asUser(carol, () =>
    db.query(
      `insert into experiments (lab_id, name, aliases) values ($1, 'P450 BM3', '{BM3,CYP102A1}'), ($1, 'Solubility screen', '{}')`,
      [labA],
    ),
  );
  await asUser(carol, () => db.query(`insert into people (lab_id, display_name, aliases) values ($1, 'Priya Nair', '{PN}')`, [labA]));
  const experimentId = ExperimentId.parse((await db.query("select id from experiments where name = 'Solubility screen'")).rows[0]?.id);
  await db.query(
    `insert into labels (lab_id, sha256, status, clean_name, date, experiment_id, instrument, tags, confidence, source)
     values ($1, $2, 'check', 'Batch 3 gel, lane 6', '2026-10-14', $4, 'ChemiDoc', '{batch 3}', 0.6, 'rules'),
            ($1, $3, 'needs_look', null, null, null, null, '{}', 0.2, 'model')`,
    [labA, sha("a"), sha("c"), experimentId],
  );
  lists = {
    experiments: ExperimentRows.parse(
      (await asUser(carol, () => db.query("select id, name, aliases from experiments where lab_id = $1", [labA]))).rows,
    ),
    people: PersonRows.parse(
      (await asUser(carol, () => db.query("select id, display_name, aliases from people where lab_id = $1", [labA]))).rows,
    ),
  };
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

  it("takes the matching text from the file's contents, never its name and path", async () => {
    const [byFolder] = await search(alice, labA, { q: "protocols" });
    expect(byFolder?.sha256).toBe(sha("b"));
    expect(byFolder?.snippet).toBe("Purify P450 on the SEC column, then run gels for batch 3.");
    const [photo] = await search(alice, labA, { q: "IMG_4821" });
    expect(photo?.sha256).toBe(sha("a"));
    expect(photo?.snippet).toBeNull();
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

describe("labels through the web app's args and parsers", () => {
  it("search_files returns the label, or null for a file not labeled yet", async () => {
    const [gel] = await search(alice, labA, { q: "IMG_4821" });
    expect(gel?.label).toMatchObject({
      status: "check",
      cleanName: "Batch 3 gel, lane 6",
      date: "2026-10-14",
      experiment: { name: "Solubility screen" },
      person: null,
      instrument: "ChemiDoc",
      tags: ["batch 3"],
    });
    const [pdf] = await search(alice, labA, { q: "P450 purification" });
    expect(pdf?.label).toBeNull();
  });

  it("file_labels returns only the files that have a label", async () => {
    const rows = FileLabelRows.parse(await asUser(carol, () => rpcJson("file_labels($1, $2)", [labA, [sha("a"), sha("b")]])));
    expect(rows.map((r) => [r.sha256, r.label.status])).toEqual([[sha("a"), "check"]]);
    expect(FileLabelRows.parse(await asUser(bob, () => rpcJson("file_labels($1, $2)", [labA, [sha("a")]])))).toEqual([]);
  });

  it("corrects a tag by alias, then undo restores the exact label", async () => {
    const [before] = await search(carol, labA, { q: "IMG_4821" });
    if (!before?.label) throw new Error("expected a label");
    const fixed = await correct(carol, labA, sha("a"), before.label, { kind: "set", tag: { kind: "experiment" }, text: "cyp102a1" });
    expect(fixed.label).toMatchObject({ status: "corrected", experiment: { name: "P450 BM3" }, cleanName: "Batch 3 gel, lane 6", confidence: 1 });

    const undone = await undo(carol, fixed.correctionId);
    expect(undone.label).toEqual(before.label);
    const again = await undo(carol, fixed.correctionId).catch((e: unknown) => e);
    expect(correctionFailure(z.object({ code: z.string(), message: z.string() }).parse(again))).toEqual({
      status: 409,
      message: "That change was already undone.",
    });
  });

  it("an unchanged label sent back is an acceptance", async () => {
    const [hit] = await search(carol, labA, { q: "IMG_4821" });
    if (!hit?.label || hit.label.status === "needs_look") throw new Error("expected a named label");
    // Same values as stored, sent the way "Looks right" sends them.
    const renamed = await correct(carol, labA, sha("a"), { ...hit.label, cleanName: "x" }, { kind: "rename", text: hit.label.cleanName });
    expect(renamed.label.status).toBe("accepted");
    await undo(carol, renamed.correctionId);
  });

  it("an empty name never reaches the database, and the database refuses one anyway", async () => {
    const [hit] = await search(carol, labA, { q: "IMG_4821" });
    if (!hit?.label) throw new Error("expected a label");
    expect(applyEdit({ label: hit.label, edit: { kind: "rename", text: " " }, lists }).kind).toBe("invalid");
    await expect(
      asUser(carol, () => db.query("select * from correct_label($1, $2, ' ', null, null, null, null, '{}')", [labA, sha("a")])),
    ).rejects.toThrow(/needs a name/);
  });

  it("needs_look_files rows parse, and naming one takes it off the queue", async () => {
    const queue = NeedsLookRows.parse(await asUser(carol, () => rpcJson("needs_look_files($1, $2)", [labA, 50])));
    expect(queue.map((f) => [f.sha256, f.locations[0].path, f.label.status])).toEqual([[sha("c"), "/Lab/Notes/zymogram.txt", "needs_look"]]);
    const count = async () =>
      NeedsLookCount.parse((await asUser(carol, () => db.query("select to_jsonb(needs_look_count($1)) as n", [labA]))).rows[0]?.n);
    expect(await count()).toBe(1);

    const named = await correct(carol, labA, sha("c"), queue[0]!.label, { kind: "rename", text: "Zymogram notes" });
    expect(named.label).toMatchObject({ status: "corrected", cleanName: "Zymogram notes" });
    expect(await count()).toBe(0);
    expect((await undo(carol, named.correctionId)).label).toEqual(queue[0]?.label);
    expect(await count()).toBe(1);
  });

  it("members add experiments, and only admins delete them", async () => {
    const add = (name: string) =>
      asUser(carol, () => db.query("insert into experiments (lab_id, name, aliases) values ($1, $2, $3) returning id", [labA, name, ["x"]]));
    const id = z.string().parse((await add("Thermal shift")).rows[0]?.id);
    const del = "delete from experiments where id = $1 and lab_id = $2";
    expect((await asUser(carol, () => db.query(del, [id, labA]))).rowCount).toBe(0);
    expect((await db.query("select 1 from experiments where id = $1", [id])).rowCount).toBe(1);
    expect((await asUser(alice, () => db.query(del, [id, labA]))).rowCount).toBe(1);
    await expect(add("p450 bm3")).rejects.toThrow(/experiments_lab_name_idx/);
  });
});

// Runs last and adds its own rows, so the search and progress counts above stay as they are.
describe("folder_tree and folder_files", () => {
  const tree = (userId: string, labId: LabId) =>
    asUser(userId, async () => FolderTreeRows.parse(await rpcJson("folder_tree($1)", [labId])));
  const files = async (userId: string, labId: LabId, path: string, limitOffset: [number, number] | null = null) =>
    asUser(userId, async () =>
      FolderFilesRows.parse(
        limitOffset === null
          ? await rpcJson("folder_files($1, $2)", [labId, path])
          : await rpcJson("folder_files($1, $2, $3, $4)", [labId, path, ...limitOffset]),
      ),
    );
  const brief = (hits: FileHit[]) =>
    hits.map((h) => ({ sha: h.sha256, paths: h.locations.map((l) => l.path), snippet: h.snippet, preview: h.hasPreview }));

  beforeAll(async () => {
    const sourceB = z
      .string()
      .parse(
        (await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/') returning id", [labB])).rows[0]?.id,
      );
    await db.query("update sources set root_path = '/Lab' where id = $1", [sourceA]);
    await db.query(
      `insert into blobs (sha256, size, mime, file_kind)
       select s, 10, 'application/octet-stream', 'other' from unnest($1::text[]) as s`,
      [["d", "e", "f", "1", "2", "3", "4", "5", "6"].map(sha)],
    );
    const loc = (
      labId: LabId,
      sourceId: string,
      path: string,
      s: string | null,
      opts: { modified?: string; state?: string; deleted?: boolean } = {},
    ) =>
      db.query(
        `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state, index_error, deleted_at)
         values ($1, $2, 'folder:' || $3::text, $3, regexp_replace($3, '^.*/', ''), 10, $4, 'rev', $5, $6::index_state,
           case when $6::index_state = 'failed' then 'unreadable' end, case when $7::boolean then now() end)`,
        [labId, sourceId, path, opts.modified ?? "2026-10-01T00:00:00Z", s, opts.state ?? "indexed", opts.deleted ?? false],
      );
    await loc(labA, sourceA, "/Lab/P450/batch3/gel.jpg", sha("d"));
    await loc(labA, sourceA, "/Lab/P450/batch3/Blot.png", sha("e"));
    await loc(labA, sourceA, "/Lab/P450/batch3/ladder.pdf", sha("b"), { modified: "2026-10-03T00:00:00Z" });
    await loc(labA, sourceA, "/Lab/P450/batch3/old.jpg", sha("2"), { deleted: true });
    await loc(labA, sourceA, "/Lab/P450/batch3/pending.pdf", null, { state: "pending" });
    await loc(labA, sourceA, "/Lab/P450/batch3/broken.pdf", null, { state: "failed" });
    await loc(labA, sourceA, "/Lab/P450/batch3/raw/run1.csv", sha("f"));
    await loc(labA, sourceA, "/Lab/P450/summary.txt", sha("1"));
    await loc(labA, sourceA, "/Lab/Pending/only.pdf", null, { state: "pending" });
    await loc(labA, sourceA, "/lab/readme.txt", sha("4"));
    await loc(labA, sourceA, "/Archive/readme.txt", sha("4"), { modified: "2026-09-01T00:00:00Z" });
    await loc(labA, sourceA, "/Lab2/outside.pdf", sha("3"));
    await loc(labB, sourceB, "/Shared/plate.pdf", sha("5"));
    await loc(labB, sourceB, "/top.txt", sha("6"));
    await db.query(
      `insert into chunks (lab_id, sha256, ord, text) values
         ($1, $2, 0, 'Lab P450 summary.txt'), ($1, $2, 1, 'Batch 3 ran clean.'), ($1, $2, 2, 'Second window.')`,
      [labA, sha("1")],
    );
  });

  it("builds the tree under the source root for a lab member", async () => {
    expect(await tree(carol, labA)).toEqual([
      { path: "", parent: null, directFiles: 1, totalFiles: 9 },
      { path: "Gels", parent: "", directFiles: 1, totalFiles: 1 },
      { path: "Old", parent: "", directFiles: 1, totalFiles: 1 },
      { path: "P450", parent: "", directFiles: 1, totalFiles: 5 },
      { path: "P450/batch3", parent: "P450", directFiles: 3, totalFiles: 4 },
      { path: "P450/batch3/raw", parent: "P450/batch3", directFiles: 1, totalFiles: 1 },
      { path: "Protocols", parent: "", directFiles: 1, totalFiles: 1 },
    ]);
  });

  it("treats a root of / as the whole account", async () => {
    expect(await tree(bob, labB)).toEqual([
      { path: "", parent: null, directFiles: 1, totalFiles: 2 },
      { path: "Shared", parent: "", directFiles: 1, totalFiles: 1 },
    ]);
  });

  it("lists a folder's live indexed files by name, each with its own location first", async () => {
    expect(brief(await files(carol, labA, "P450/batch3"))).toEqual([
      { sha: sha("e"), paths: ["/Lab/P450/batch3/Blot.png"], snippet: null, preview: false },
      { sha: sha("d"), paths: ["/Lab/P450/batch3/gel.jpg"], snippet: null, preview: false },
      {
        sha: sha("b"),
        paths: ["/Lab/P450/batch3/ladder.pdf", "/Lab/Protocols/P450 purification.pdf", "/Lab/Old/P450 purification copy.pdf"],
        snippet: "Purify P450 on the SEC column, then run gels for batch 3.",
        preview: false,
      },
    ]);
    expect(brief(await files(carol, labA, "Protocols"))[0]?.paths).toEqual([
      "/Lab/Protocols/P450 purification.pdf",
      "/Lab/P450/batch3/ladder.pdf",
      "/Lab/Old/P450 purification copy.pdf",
    ]);
    expect(brief(await files(carol, labA, "P450"))).toEqual([
      { sha: sha("1"), paths: ["/Lab/P450/summary.txt"], snippet: "Batch 3 ran clean.", preview: false },
    ]);
    expect(brief(await files(carol, labA, "Gels"))[0]?.preview).toBe(true);
  });

  it("lists the root folder, including other locations outside the root", async () => {
    expect(brief(await files(carol, labA, ""))).toEqual([
      { sha: sha("4"), paths: ["/lab/readme.txt", "/Archive/readme.txt"], snippet: null, preview: false },
    ]);
    expect(brief(await files(bob, labB, "")).map((h) => h.paths)).toEqual([["/top.txt"]]);
  });

  it("pages with limit and offset", async () => {
    expect((await files(carol, labA, "P450/batch3", [1, 0])).map((h) => h.sha256)).toEqual([sha("e")]);
    expect((await files(carol, labA, "P450/batch3", [2, 1])).map((h) => h.sha256)).toEqual([sha("d"), sha("b")]);
    expect(await files(carol, labA, "P450/batch3", [10, 3])).toEqual([]);
  });

  it("returns nothing for folders with no live indexed files", async () => {
    expect(await files(carol, labA, "Pending")).toEqual([]);
    expect(await files(carol, labA, "Notes")).toEqual([]);
  });

  it("returns nothing across labs", async () => {
    expect(await tree(bob, labA)).toEqual([]);
    expect(await files(bob, labA, "P450/batch3")).toEqual([]);
    expect(await files(bob, labA, "")).toEqual([]);
    expect(await tree(alice, labB)).toEqual([]);
    expect(await files(alice, labB, "Shared")).toEqual([]);
    expect(await files(alice, labB, "")).toEqual([]);
  });
});
