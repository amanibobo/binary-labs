import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { DayEventRows, EntryDraft, EntryJson, EntryJsonRows, entryColumns, RecordRows, recordLine } from "../calendar";
import { CalendarDay, instantAt } from "../calendar-time";
import { CreateLabResult } from "../domain";
import { FolderFilesRows } from "../folders";
import { LabId } from "../ids";

// The calendar's SQL against the real migrations, as members of two labs with RLS on, read the
// way PostgREST serializes rows and parsed with the web app's own schemas.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ana = "00000000-0000-4000-8000-0000000000e1";
const ben = "00000000-0000-4000-8000-0000000000e2";
const NY = "America/New_York";
const day = (s: string) => CalendarDay.parse(s);
let labA: LabId;
let labB: LabId;

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

async function jsonRows(sql: string, params: unknown[]): Promise<unknown> {
  const res = await db.query(`select coalesce(jsonb_agg(j), '[]'::jsonb) as rows from ${sql} j`, params);
  return z.object({ rows: z.unknown() }).parse(res.rows[0]).rows;
}

const draft = (title: string, when: EntryDraft["when"]): EntryDraft => ({
  title,
  notes: null,
  when,
  experimentId: null,
  protocolId: null,
  instrumentId: null,
  personIds: [],
});

async function insert(userId: string, labId: LabId, d: EntryDraft) {
  const c = entryColumns(EntryDraft.parse(d));
  const cols = ["lab_id", ...Object.keys(c)];
  const values = [labId, ...Object.values(c)];
  return asUser(userId, async () => {
    const res = await db.query(
      `insert into calendar_entries (${cols.join(", ")}) values (${values.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      values,
    );
    return z.object({ id: z.string() }).parse(res.rows[0]).id;
  });
}

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'ana@lab.test'), ($2, 'ben@lab.test') on conflict do nothing", [ana, ben]);
  labA = LabId.parse(CreateLabResult.parse((await asUser(ana, () => db.query("select create_lab('Calendar lab A') as id"))).rows[0]?.id));
  labB = LabId.parse(CreateLabResult.parse((await asUser(ben, () => db.query("select create_lab('Calendar lab B') as id"))).rows[0]?.id));
  const source = await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/x') returning id", [labA]);
  const experiment = await db.query("insert into experiments (lab_id, name) values ($1, 'P450 BM3') returning id", [labA]);
  for (let i = 0; i < 3; i++) {
    const sha = String(i).repeat(64);
    await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 1, 'application/pdf', 'pdf') on conflict do nothing", [sha]);
    await db.query(
      `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
       values ($1, $2, $3, $4, $3, 1, '2026-10-01', 'r', $5, 'indexed')`,
      [labA, source.rows[0]?.id, `gel${i}.pdf`, `/Gels/gel${i}.pdf`, sha],
    );
    await db.query(
      `insert into labels (lab_id, sha256, status, clean_name, date, experiment_id, confidence, source)
       values ($1, $2, 'accepted', $3, '2026-11-03', $4, 0.9, 'test')`,
      [labA, sha, `Gel ${i}`, experiment.rows[0]?.id],
    );
  }
  await asUser(ana, () => db.query("select create_protocol($1, 'protocol', 'Bradford assay', '1. Mix.')", [labA]));
});

afterAll(async () => {
  await db.query("delete from labs where id = any($1)", [[labA, labB]]);
  await db.end();
});

describe("the calendar's reads parse as the web app reads them", () => {
  it("counts a week's record per day and names each line", async () => {
    const raw = await asUser(ana, () =>
      rows("select * from calendar_record($1, '2026-11-01', '2026-11-07', $2)", [labA, NY]),
    );
    const record = RecordRows.parse(raw);
    const files = record.find((g) => g.kind === "file");
    expect(files).toMatchObject({ day: "2026-11-03", items: 3, groupName: "P450 BM3" });
    expect(files === undefined ? null : recordLine(files)).toBe("3 files · P450 BM3");
  });

  it("pages a day's files into the same rows search shows", async () => {
    const shas = await asUser(ana, async () =>
      z
        .array(z.object({ sha256: z.string() }))
        .parse(
          await rows("select sha256 from calendar_files($1, '2026-11-03', '2026-11-03', $2) order by name limit 2", [labA, NY]),
        )
        .map((r) => r.sha256),
    );
    const hits = FolderFilesRows.parse(await asUser(ana, () => rows("select * from file_hits($1, $2)", [labA, shas])));
    expect(hits.map((h) => h.label?.cleanName)).toEqual(["Gel 0", "Gel 1"]);
  });

  it("lists a day's protocol saves as events", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const events = DayEventRows.parse(
      await asUser(ana, () => rows("select kind, target, title, at, actor from calendar_events($1, $2, $2, 'UTC')", [labA, today])),
    );
    expect(events).toMatchObject([{ kind: "protocol", title: "Bradford assay", actor: ana }]);
  });

  it("reads plans back in the shape the editor wrote, all day and timed", async () => {
    const start = instantAt(day("2026-11-05"), 14 * 60, NY).toISOString();
    const end = instantAt(day("2026-11-05"), 15 * 60, NY).toISOString();
    await insert(ana, labA, draft("Retreat", { kind: "allDay", first: day("2026-11-06"), last: day("2026-11-08") }));
    const timed = await insert(ana, labA, draft("Plate reads", { kind: "timed", start, end }));
    const plans = EntryJsonRows.parse(
      await asUser(ana, () => jsonRows("calendar_plans($1, '2026-11-01', '2026-11-07', $2)", [labA, NY])),
    );
    expect(plans.map((p) => [p.title, p.when])).toEqual([
      ["Plate reads", { kind: "timed", start: expect.any(String), end: expect.any(String) }],
      ["Retreat", { kind: "allDay", first: "2026-11-06", last: "2026-11-08" }],
    ]);
    const first = plans[0];
    expect(first?.when.kind === "timed" ? Date.parse(first.when.start) : null).toBe(Date.parse(start));
    expect(first?.createdBy).toBe(ana);

    // Another lab sees none of it, and can't read it by id.
    const theirs = await asUser(ben, () => db.query("select calendar_entry($1) as e", [timed]));
    expect(theirs.rows[0]?.e).toBeNull();
    const mine = await asUser(ana, () => db.query("select calendar_entry($1) as e", [timed]));
    expect(EntryJson.parse(mine.rows[0]?.e).title).toBe("Plate reads");
  });

  it("refuses a save based on an older version", async () => {
    const id = await insert(ana, labA, draft("Gel run", { kind: "allDay", first: day("2026-11-09"), last: day("2026-11-09") }));
    const before = EntryJson.parse((await asUser(ana, () => db.query("select calendar_entry($1) as e", [id]))).rows[0]?.e);
    const update = (title: string) =>
      asUser(ana, () => db.query("update calendar_entries set title = $1 where id = $2 and updated_at = $3", [title, id, before.updatedAt]));
    expect((await update("Gel run, lanes 1 to 8")).rowCount).toBe(1);
    expect((await update("Someone else's title")).rowCount).toBe(0);
  });
});
