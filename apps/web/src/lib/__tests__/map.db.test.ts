import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { LabId } from "../ids";
import { HubFiles, HubView, LocalView } from "../map";

// The lab map's three views against the real migrations, as members of two labs with RLS on:
// what a member sees of their own lab, and that nothing of the other lab ever shows up, even
// for a file both labs hold.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const rosa = "00000000-0000-4000-8000-000000000a71";
const sam = "00000000-0000-4000-8000-000000000a72";
const sha = (n: number) => `f${n.toString(16).padStart(63, "0")}`;
// One gel both labs hold; each labels it its own way.
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
let other: string;

async function addFile(lab: LabId, source: string, n: string, name: string, kind = "spreadsheet") {
  await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/csv', $2) on conflict do nothing", [n, kind]);
  await db.query(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, $3, '/' || $3, $3, 10, now() - make_interval(mins => $4), 'r', $5, 'indexed')`,
    [lab, source, name, parseInt(n.slice(-2), 16), n],
  );
}

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'rosa@map.test'), ($2, 'sam@map.test') on conflict do nothing", [rosa, sam]);
  labA = LabId.parse(CreateLabResult.parse((await asUser(rosa, () => db.query("select create_lab('Map lab A') as id"))).rows[0]?.id));
  labB = LabId.parse(CreateLabResult.parse((await asUser(sam, () => db.query("select create_lab('Map lab B') as id"))).rows[0]?.id));
  const sourceA = (await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/a') returning id", [labA])).rows[0]?.id;
  const sourceB = (await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/b') returning id", [labB])).rows[0]?.id;
  await addFile(labA, sourceA, sha(1), "plate7_read1.csv");
  await addFile(labA, sourceA, sha(2), "plate7_read2.csv");
  await addFile(labA, sourceA, sha(3), "SEC_trace.csv");
  await addFile(labA, sourceA, sha(4), "gone.csv");
  await addFile(labA, sourceA, SHARED, "IMG_4821.jpg", "image");
  await addFile(labB, sourceB, SHARED, "IMG_4821.jpg", "image");
  await db.query("update file_locations set deleted_at = now() where sha256 = $1", [sha(4)]);

  await asUser(rosa, async () => {
    protocol = (await db.query("select protocol_id from create_protocol($1, 'protocol', 'Plate reader kinetics', 'Read every minute.')", [labA])).rows[0]?.protocol_id;
    experiment = (await db.query("insert into experiments (lab_id, name) values ($1, 'Screen plate 07') returning id", [labA])).rows[0]?.id;
    await db.query("update experiments set protocol_id = $1 where id = $2", [protocol, experiment]);
    person = (await db.query("insert into people (lab_id, display_name) values ($1, 'Priya Raman') returning id", [labA])).rows[0]?.id;
    await db.query("select link_protocol_file($1, $2)", [protocol, sha(3)]);
  });
  await asUser(sam, async () => {
    other = (await db.query("insert into experiments (lab_id, name) values ($1, 'Lab B secret') returning id", [labB])).rows[0]?.id;
  });
  // Labels as the worker writes them.
  const label = (lab: LabId, s: string, name: string, exp: string | null, who: string | null, instrument: string | null, status = "accepted") =>
    db.query(
      `insert into labels (lab_id, sha256, status, clean_name, experiment_id, person_id, instrument, confidence, source)
       values ($1, $2, $3, $4, $5, $6, $7, 0.9, 'rules')`,
      [lab, s, status, status === "needs_look" ? null : name, exp, who, instrument],
    );
  await label(labA, sha(1), "Plate 7 read 1", experiment, person, "SpectraMax M5");
  await label(labA, sha(2), "Plate 7 read 2", experiment, null, "spectramax m5 ");
  await label(labA, sha(4), "Gone", experiment, person, null);
  await label(labA, SHARED, "Batch 3 gel", null, person, null);
  await label(labB, SHARED, "Lab B gel", other, null, "ChemiDoc");
  // The worker's neighbor cache: plate reads 1 and 2 are alike.
  await db.query("insert into file_vectors (lab_id, sha256) values ($1, $2), ($1, $3), ($1, $4) on conflict do nothing", [labA, sha(1), sha(2), sha(3)]);
  await db.query("insert into file_neighbors (lab_id, sha256, neighbor, similarity) values ($1, $2, $3, 0.93), ($1, $3, $2, 0.93)", [labA, sha(1), sha(2)]);
});

afterAll(async () => {
  await db.query("delete from labs where id = any($1)", [[labA, labB]]);
  await db.end();
});

describe("the lab map", () => {
  it("shows a member their lab's hubs, how many live files each holds, and an experiment's protocol", async () => {
    const view = HubView.parse(await call(rosa, "lab_map($1)", [labA]));
    const byName = Object.fromEntries(view.hubs.map((h) => [h.name, h]));
    expect(Object.keys(byName).sort()).toEqual(["Plate reader kinetics", "Priya Raman", "Screen plate 07", "SpectraMax M5"]);
    // Two plate reads; the gone file isn't counted; both spellings are one instrument.
    expect(byName["Screen plate 07"]?.files).toBe(2);
    expect(byName["SpectraMax M5"]?.files).toBe(2);
    expect(byName["Priya Raman"]?.files).toBe(2);
    expect(byName["Plate reader kinetics"]?.files).toBe(1);
    expect(view.files).toBe(4);
    expect(view.links.find((l) => l.kind === "uses")).toMatchObject({ source: `experiment:${experiment}`, target: `protocol:${protocol}` });
    expect(view.links.some((l) => l.kind === "shared" && (l.source === `experiment:${experiment}` || l.target === `experiment:${experiment}`))).toBe(true);
  });

  it("opens a hub's files with their links, and similar pairs only when asked", async () => {
    const hub = HubFiles.parse(await call(rosa, "lab_map_hub($1, $2)", [labA, `experiment:${experiment}`]));
    expect(hub.total).toBe(2);
    expect(hub.nodes.map((n) => n.name).sort()).toEqual(["Plate 7 read 1", "Plate 7 read 2"]);
    expect(hub.edges.filter((e) => e.kind === "similar")).toEqual([]);
    expect(hub.edges.filter((e) => e.source === `file:${sha(1)}`).map((e) => e.target).sort()).toEqual(
      [`experiment:${experiment}`, "instrument:spectramax m5", `person:${person}`].sort(),
    );
    const similar = HubFiles.parse(await call(rosa, "lab_map_hub($1, $2, 400, true)", [labA, `experiment:${experiment}`]));
    expect(similar.edges.filter((e) => e.kind === "similar")).toEqual([
      { source: `file:${sha(1)}`, target: `file:${sha(2)}`, kind: "similar", similarity: 0.93 },
    ]);
  });

  it("maps one step and two steps around a file", async () => {
    const near = LocalView.parse(await call(rosa, "lab_map_local($1, $2, 1)", [labA, `file:${sha(1)}`]));
    expect(near.nodes.map((n) => n.id).sort()).toEqual([`experiment:${experiment}`, `file:${sha(1)}`, "instrument:spectramax m5", `person:${person}`].sort());
    expect(near.more.find((m) => m.hub === `experiment:${experiment}`)?.hidden).toBe(1);
    const far = LocalView.parse(await call(rosa, "lab_map_local($1, $2, 2)", [labA, `file:${sha(1)}`]));
    const ids = far.nodes.map((n) => n.id);
    expect(ids).toContain(`file:${sha(2)}`);
    expect(ids).toContain(`protocol:${protocol}`);
    expect(ids).toContain(`file:${SHARED}`);
    expect(ids).not.toContain(`file:${sha(4)}`);
    const similar = LocalView.parse(await call(rosa, "lab_map_local($1, $2, 1, true)", [labA, `file:${sha(1)}`]));
    expect(similar.nodes.map((n) => n.id)).toContain(`file:${sha(2)}`);
    const aroundProtocol = LocalView.parse(await call(rosa, "lab_map_local($1, $2, 1)", [labA, `protocol:${protocol}`]));
    expect(aroundProtocol.nodes.map((n) => n.id).sort()).toEqual([`experiment:${experiment}`, `file:${sha(3)}`, `protocol:${protocol}`].sort());
  });

  it("never shows one lab's nodes to another, even for a file both hold", async () => {
    await expect(call(sam, "lab_map($1)", [labA])).rejects.toThrow(/not a member/);
    await expect(call(sam, "lab_map_hub($1, $2)", [labA, `experiment:${experiment}`])).rejects.toThrow(/not a member/);
    await expect(call(sam, "lab_map_local($1, $2, 2, true)", [labA, `file:${SHARED}`])).rejects.toThrow(/not a member/);
    await expect(call(null, "lab_map($1)", [labA])).rejects.toThrow(/not a member/);

    const mine = HubView.parse(await call(sam, "lab_map($1)", [labB]));
    expect(mine.hubs.map((h) => h.name).sort()).toEqual(["ChemiDoc", "Lab B secret"]);
    const gel = LocalView.parse(await call(sam, "lab_map_local($1, $2, 2, true)", [labB, `file:${SHARED}`]));
    expect(gel.nodes.map((n) => n.kind === "file" ? n.id : n.name).sort()).toEqual(["ChemiDoc", "Lab B secret", `file:${SHARED}`].sort());
    expect(gel.nodes.find((n) => n.id === `file:${SHARED}`)).toMatchObject({ name: "Lab B gel" });
    // Lab A's hubs asked for by id from lab B are no such thing there.
    expect(await call(sam, "lab_map_hub($1, $2)", [labB, `experiment:${experiment}`])).toBeNull();
    expect(await call(sam, "lab_map_local($1, $2)", [labB, `person:${person}`])).toBeNull();
    expect(await asUser(sam, async () => (await db.query("select * from file_neighbors")).rows)).toEqual([]);
  });

  it("keeps its helpers and the neighbor cache out of members' reach", async () => {
    await expect(call(rosa, "map_links($1)", [labA])).rejects.toThrow(/permission denied/);
    await expect(call(rosa, "map_hub_files($1, $2, 10)", [labA, `experiment:${experiment}`])).rejects.toThrow(/permission denied/);
    await expect(asUser(rosa, () => db.query("select count(*) from file_vectors"))).rejects.toThrow(/permission denied/);
    await expect(asUser(rosa, () => db.query("delete from file_neighbors"))).rejects.toThrow(/permission denied/);
    expect((await asUser(rosa, () => db.query("select count(*)::int as n from file_neighbors"))).rows[0]?.n).toBe(2);
  });

  // Last: archiving can't be undone.
  it("leaves out an archived protocol and a label still waiting for a look", async () => {
    await db.query("update labels set status = 'needs_look', clean_name = null where lab_id = $1 and sha256 = $2", [labA, sha(2)]);
    await db.query("update protocols set archived_at = now() where id = $1", [protocol]);
    try {
      const view = HubView.parse(await call(rosa, "lab_map($1)", [labA]));
      expect(view.hubs.map((h) => h.name)).not.toContain("Plate reader kinetics");
      expect(view.hubs.find((h) => h.name === "Screen plate 07")?.files).toBe(1);
      expect(view.links.some((l) => l.kind === "uses")).toBe(false);
    } finally {
      await db.query("update labels set status = 'accepted', clean_name = 'Plate 7 read 2' where lab_id = $1 and sha256 = $2", [labA, sha(2)]);
    }
  });
});
