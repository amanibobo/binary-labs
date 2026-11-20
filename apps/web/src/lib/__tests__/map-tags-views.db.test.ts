import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { LabId } from "../ids";
import { HubFiles, HubView, LocalView, savedViewOf } from "../map";

// Migration 0032 against the real migrations with RLS on: tags as dots (off unless asked),
// similar in meaning between hubs, and each member's own saved view of the map.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const rosa = "00000000-0000-4000-8000-000000000b71";
const lee = "00000000-0000-4000-8000-000000000b72";
const sam = "00000000-0000-4000-8000-000000000b73";
const sha = (n: number) => `e${n.toString(16).padStart(63, "0")}`;
const SHARED = sha(9);

async function asUser<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query("set local role authenticated");
    if (userId !== null) await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
    const out = await fn();
    await db.query("commit");
    return out;
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
}

const one = z.object({ v: z.unknown() });
async function call(userId: string | null, sql: string, params: unknown[]): Promise<unknown> {
  return asUser(userId, async () => one.parse((await db.query(`select ${sql} as v`, params)).rows[0]).v);
}

let labA: LabId;
let labB: LabId;
let experiment: string;
let protocol: string;
let person: string;

async function addFile(lab: LabId, source: string, n: string, name: string) {
  await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/csv', 'spreadsheet') on conflict do nothing", [n]);
  await db.query(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, $3, '/' || $3, $3, 10, now() - make_interval(mins => $4), 'r', $5, 'indexed')`,
    [lab, source, name, parseInt(n.slice(-2), 16), n],
  );
}

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'rosa@tags.test'), ($2, 'lee@tags.test'), ($3, 'sam@tags.test') on conflict do nothing", [rosa, lee, sam]);
  labA = LabId.parse(CreateLabResult.parse((await asUser(rosa, () => db.query("select create_lab('Tags lab A') as id"))).rows[0]?.id));
  labB = LabId.parse(CreateLabResult.parse((await asUser(sam, () => db.query("select create_lab('Tags lab B') as id"))).rows[0]?.id));
  await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [labA, lee]);
  const sourceA = (await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/a') returning id", [labA])).rows[0]?.id;
  const sourceB = (await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/b') returning id", [labB])).rows[0]?.id;
  for (const [n, name] of [[1, "read1.csv"], [2, "read2.csv"], [3, "sec.csv"], [4, "gone.csv"], [5, "waiting.csv"]] as const) {
    await addFile(labA, sourceA, sha(n), name);
  }
  await addFile(labA, sourceA, SHARED, "shared.csv");
  await addFile(labB, sourceB, SHARED, "shared.csv");
  await db.query("update file_locations set deleted_at = now() where sha256 = $1", [sha(4)]);
  await asUser(rosa, async () => {
    protocol = (await db.query("select protocol_id from create_protocol($1, 'protocol', 'Plate reader kinetics', 'Read every minute.')", [labA])).rows[0]?.protocol_id;
    experiment = (await db.query("insert into experiments (lab_id, name) values ($1, 'Screen plate 07') returning id", [labA])).rows[0]?.id;
    person = (await db.query("insert into people (lab_id, display_name) values ($1, 'Priya Raman') returning id", [labA])).rows[0]?.id;
    await db.query("select link_protocol_file($1, $2)", [protocol, sha(3)]);
  });
  const label = (lab: LabId, s: string, exp: string | null, who: string | null, instrument: string | null, tags: string[], status = "accepted") =>
    db.query(
      `insert into labels (lab_id, sha256, status, clean_name, experiment_id, person_id, instrument, tags, confidence, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 0.9, 'rules')`,
      [lab, s, status, status === "needs_look" ? null : `Label ${s.slice(-1)}`, exp, who, instrument, tags],
    );
  // "Triplicate" on two live files in two spellings, plus one deleted file; "pH 7.4" on one.
  await label(labA, sha(1), experiment, person, "SpectraMax M5", ["Triplicate", "pH 7.4"]);
  await label(labA, sha(2), experiment, null, "SpectraMax M5", ["triplicate "]);
  await label(labA, sha(4), experiment, person, null, ["Triplicate"]);
  // A label waiting for a look draws no tag.
  await label(labA, sha(5), null, null, null, ["triplicate"], "needs_look");
  await label(labA, SHARED, null, person, null, ["blank", "Blank"]);
  await label(labB, SHARED, null, null, null, ["lab b secret", "lab b secret 2"]);
  // Similar files: reads 1 and 2 each read like the SEC trace (on both lists, as the worker
  // keeps them), so the experiment and the instrument read like the protocol.
  await db.query("insert into file_vectors (lab_id, sha256) values ($1, $2), ($1, $3), ($1, $4) on conflict do nothing", [labA, sha(1), sha(2), sha(3)]);
  await db.query(
    `insert into file_neighbors (lab_id, sha256, neighbor, similarity) values
     ($1, $2, $4, 0.9), ($1, $4, $2, 0.9), ($1, $3, $4, 0.8), ($1, $4, $3, 0.8), ($1, $2, $3, 0.95)`,
    [labA, sha(1), sha(2), sha(3)],
  );
});

afterAll(async () => {
  await db.query("delete from labs where id = any($1)", [[labA, labB]]);
  await db.end();
});

const tagIds = (ids: string[]) => ids.filter((id) => id.startsWith("tag:")).sort();

describe("tags on the lab map", () => {
  it("draws no tags unless asked, and then those on two or more live files, by the spelling most use", async () => {
    const off = HubView.parse(await call(rosa, "lab_map($1)", [labA]));
    expect(tagIds(off.hubs.map((h) => h.id))).toEqual([]);
    expect(off.links.some((l) => l.source.startsWith("tag:") || l.target.startsWith("tag:"))).toBe(false);

    const on = HubView.parse(await call(rosa, "lab_map($1, false, true)", [labA]));
    // Triplicate: two live files (the deleted one and the one waiting for a look don't count);
    // blank: one file twice is still one file; pH 7.4: one file.
    expect(on.hubs.filter((h) => h.kind === "tag")).toEqual([{ id: "tag:triplicate", kind: "tag", name: "Triplicate", files: 2 }]);
    const tagLinks = on.links.filter((l) => l.source === "tag:triplicate");
    expect(tagLinks.map((l) => l.target).sort()).toEqual([`experiment:${experiment}`, "instrument:spectramax m5"].sort());
    expect(tagLinks.every((l) => l.kind === "shared" && l.weight === 2)).toBe(true);
    // The hubs and their own links are the same with tags on.
    expect(on.hubs.filter((h) => h.kind !== "tag")).toEqual(off.hubs);
    expect(on.links.filter((l) => !l.source.startsWith("tag:"))).toEqual(off.links);
  });

  it("opens a tag's files like any hub's, and links files to tags only with tags on", async () => {
    const tag = HubFiles.parse(await call(rosa, "lab_map_hub($1, $2)", [labA, "tag:triplicate"]));
    expect(tag.total).toBe(2);
    expect(tag.nodes.map((n) => n.id).sort()).toEqual([`file:${sha(1)}`, `file:${sha(2)}`]);
    expect(tag.edges.filter((e) => e.target === "tag:triplicate").length).toBe(2);
    // A tag on one file can still be opened, by its id.
    expect(HubFiles.parse(await call(rosa, "lab_map_hub($1, $2)", [labA, "tag:ph 7.4"])).total).toBe(1);

    const exp = HubFiles.parse(await call(rosa, "lab_map_hub($1, $2)", [labA, `experiment:${experiment}`]));
    expect(exp.edges.some((e) => e.target.startsWith("tag:"))).toBe(false);
    const withTags = HubFiles.parse(await call(rosa, "lab_map_hub($1, $2, 400, false, '{}', true)", [labA, `experiment:${experiment}`]));
    expect(withTags.edges.filter((e) => e.target.startsWith("tag:")).map((e) => `${e.source}>${e.target}`).sort()).toEqual(
      [`file:${sha(1)}>tag:ph 7.4`, `file:${sha(1)}>tag:triplicate`, `file:${sha(2)}>tag:triplicate`].sort(),
    );
  });

  it("puts a file's tags one step out with tags on, and maps around a tag", async () => {
    const off = LocalView.parse(await call(rosa, "lab_map_local($1, $2, 1)", [labA, `file:${sha(1)}`]));
    expect(tagIds(off.nodes.map((n) => n.id))).toEqual([]);
    const on = LocalView.parse(await call(rosa, "lab_map_local($1, $2, 1, false, true)", [labA, `file:${sha(1)}`]));
    expect(tagIds(on.nodes.map((n) => n.id))).toEqual(["tag:ph 7.4", "tag:triplicate"]);
    expect(on.nodes.find((n) => n.id === "tag:triplicate")).toEqual({ id: "tag:triplicate", kind: "tag", name: "Triplicate", files: 2 });
    expect(on.more.find((m) => m.hub === "tag:triplicate")?.hidden).toBe(1);

    const around = LocalView.parse(await call(rosa, "lab_map_local($1, $2, 1, false, true)", [labA, "tag:triplicate"]));
    expect(around.nodes.map((n) => n.id).sort()).toEqual(["tag:triplicate", `file:${sha(1)}`, `file:${sha(2)}`].sort());
  });

  it("never shows another lab's tags, even on a file both labs hold", async () => {
    await expect(call(sam, "lab_map($1, false, true)", [labA])).rejects.toThrow(/not a member/);
    const near = LocalView.parse(await call(rosa, "lab_map_local($1, $2, 1, false, true)", [labA, `file:${SHARED}`]));
    expect(tagIds(near.nodes.map((n) => n.id))).toEqual(["tag:blank"]);
    expect(await call(rosa, "lab_map_hub($1, $2)", [labA, "tag:lab b secret"])).toBeNull();
    expect(await call(rosa, "lab_map_local($1, $2, 1, false, true)", [labA, "tag:lab b secret"])).toBeNull();
    const theirs = HubView.parse(await call(sam, "lab_map($1, false, true)", [labB]));
    expect(theirs.hubs.filter((h) => h.kind === "tag")).toEqual([]);
  });
});

describe("similar in meaning between hubs", () => {
  it("joins hubs whose files read alike, counting a pair on both lists once, only when asked", async () => {
    const off = HubView.parse(await call(rosa, "lab_map($1)", [labA]));
    expect(off.links.filter((l) => l.kind === "similar")).toEqual([]);
    const on = HubView.parse(await call(rosa, "lab_map($1, true)", [labA]));
    const similar = on.links.filter((l) => l.kind === "similar");
    // Reads 1 and 2 are each like the SEC trace, so the experiment and the instrument each have
    // two pairs with the protocol. Priya has one (too few). Reads 1 and 2 are alike too, but
    // every hub of read 2's also holds read 1, so that pair says nothing about two hubs.
    expect(similar.map((l) => [l.source, l.target].sort().join(" ~ ")).sort()).toEqual(
      [[`experiment:${experiment}`, `protocol:${protocol}`].sort().join(" ~ "), ["instrument:spectramax m5", `protocol:${protocol}`].sort().join(" ~ ")].sort(),
    );
    expect(similar.every((l) => l.kind === "similar" && l.similarity === 0.85)).toBe(true);
  });
});

describe("each member's saved view", () => {
  const camera = { anchor: `experiment:${"0".repeat(8)}-0000-4000-8000-000000000001`, k: 2.5, dx: -12.5, dy: 40 };
  const read = (user: string, lab: LabId) =>
    asUser(user, async () => (await db.query("select camera, open_hubs, hidden_kinds, show_similar, show_tags from map_views where lab_id = $1", [lab])).rows);

  it("saves and reads back a member's own view, and saving it again changes only the time", async () => {
    expect(await read(rosa, labA)).toEqual([]);
    await call(rosa, "save_map_view($1, $2, $3, $4, true, true)", [labA, camera, [`experiment:${experiment}`, "tag:triplicate"], ["file"]]);
    await call(rosa, "save_map_view($1, $2, $3, $4, true, true)", [labA, camera, [`experiment:${experiment}`, "tag:triplicate"], ["file"]]);
    const rows = await read(rosa, labA);
    expect(rows).toEqual([{ camera, open_hubs: [`experiment:${experiment}`, "tag:triplicate"], hidden_kinds: ["file"], show_similar: true, show_tags: true }]);
    expect(savedViewOf(rows[0])).toEqual({ camera, open: [`experiment:${experiment}`, "tag:triplicate"], hidden: ["file"], similar: true, tags: true });
  });

  it("keeps the camera and open hubs when a map around one thing saves its switches", async () => {
    await call(rosa, "save_map_view($1, null, null, '{}', false, false)", [labA]);
    expect(await read(rosa, labA)).toEqual([{ camera, open_hubs: [`experiment:${experiment}`, "tag:triplicate"], hidden_kinds: [], show_similar: false, show_tags: false }]);
    // Fitting the map again on the lab map clears the camera.
    await call(rosa, "save_map_view($1, null, '{}', '{}', false, false)", [labA]);
    expect((await read(rosa, labA))[0]).toMatchObject({ camera: null, open_hubs: [] });
  });

  it("is the member's alone: another member of the lab neither reads nor writes it, and a non-member can't save", async () => {
    expect(await read(lee, labA)).toEqual([]);
    await call(lee, "save_map_view($1, null, '{}', $2, false, true)", [labA, ["person"]]);
    expect(await read(lee, labA)).toEqual([{ camera: null, open_hubs: [], hidden_kinds: ["person"], show_similar: false, show_tags: true }]);
    expect((await read(rosa, labA))[0]).toMatchObject({ hidden_kinds: [], show_tags: false });
    await expect(asUser(lee, () => db.query("update map_views set show_tags = false where user_id = $1", [rosa]))).resolves.toMatchObject({ rowCount: 0 });
    await expect(asUser(lee, () => db.query("insert into map_views (lab_id, user_id) values ($1, $2)", [labA, rosa]))).rejects.toThrow(/row-level security/);
    await expect(call(sam, "save_map_view($1, null, '{}', '{}', false, false)", [labA])).rejects.toThrow(/not a member/);
    await expect(call(null, "save_map_view($1, null, '{}', '{}', false, false)", [labA])).rejects.toThrow(/not a member/);
    await expect(asUser(sam, () => db.query("select * from map_views"))).resolves.toMatchObject({ rowCount: 0 });
  });

  it("refuses a camera or a kind it couldn't restore", async () => {
    const bad = [{ ...camera, k: 100 }, { ...camera, extra: 1 }, { anchor: camera.anchor, k: 1, dx: 0 }, { ...camera, dx: "far" }];
    for (const c of bad) await expect(call(rosa, "save_map_view($1, $2, '{}', '{}', false, false)", [labA, c])).rejects.toThrow(/check constraint/);
    await expect(call(rosa, "save_map_view($1, null, '{}', $2, false, false)", [labA, ["tag"]])).rejects.toThrow(/check constraint/);
  });

  it("is out of the member's reach once they leave the lab", async () => {
    await db.query("delete from members where lab_id = $1 and user_id = $2", [labA, lee]);
    expect(await read(lee, labA)).toEqual([]);
    await expect(call(lee, "save_map_view($1, null, '{}', '{}', false, false)", [labA])).rejects.toThrow(/not a member/);
  });
});
