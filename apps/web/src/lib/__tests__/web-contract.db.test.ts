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
  type Label,
  type SearchParams,
} from "../domain";
import { ExperimentId, LabId, Sha256, type CorrectionId } from "../ids";
import { applyEdit, type LabLists } from "../label-edit";
import { correctLabelArgs, correctRequest } from "../labels";
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
    await expect(undo(carol, fixed.correctionId)).rejects.toThrow(/already undone/);
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
