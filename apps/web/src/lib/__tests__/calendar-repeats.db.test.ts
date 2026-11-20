import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { EntryDraft, EntryJson, EntryJsonRows, entryColumns, type CalendarEntry } from "../calendar";
import { feedIcs, FeedJson } from "../calendar-feed";
import { repeatDays, ruleArg, type RepeatRule } from "../calendar-repeat";
import { CalendarDay, instantAt, wallClock } from "../calendar-time";
import { CreateLabResult } from "../domain";
import { LabId } from "../ids";

// Repeats, reminders, the feed and notes (migration 0030) against the real migrations, as
// members with RLS on, parsed with the web app's own schemas.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ana = "00000000-0000-4000-8000-0000000001ca";
const ben = "00000000-0000-4000-8000-0000000001cb";
const cy = "00000000-0000-4000-8000-0000000001cc";
const NY = "America/New_York";
const day = (s: string) => CalendarDay.parse(s);
const timed = (d: string, hour: number, minutes = 60): EntryDraft["when"] => {
  const start = instantAt(day(d), hour * 60, NY);
  return { kind: "timed", start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString() };
};
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

const draft = (title: string, when: EntryDraft["when"]): EntryDraft => ({
  title,
  notes: null,
  when,
  experimentId: null,
  protocolId: null,
  instrumentId: null,
  personIds: [],
});

async function insert(userId: string, labId: LabId, d: EntryDraft): Promise<CalendarEntry> {
  const c = entryColumns(EntryDraft.parse(d));
  const cols = ["lab_id", ...Object.keys(c)];
  const values = [labId, ...Object.values(c)];
  return asUser(userId, async () => {
    const res = await db.query(
      `insert into calendar_entries (${cols.join(", ")}) values (${values.map((_, i) => `$${i + 1}`).join(", ")}) returning calendar_entry_json(calendar_entries.*) as e`,
      values,
    );
    return EntryJson.parse(res.rows[0]?.e);
  });
}

const Outcome = z.object({ kind: z.enum(["saved", "stale"]), entry: EntryJson.nullable() });

async function repeat(userId: string, entry: CalendarEntry, rule: RepeatRule | null) {
  const res = await asUser(userId, () =>
    db.query("select calendar_repeat($1, $2, $3, $4) as o", [entry.id, entry.updatedAt, rule === null ? null : ruleArg(rule), NY]),
  );
  return Outcome.parse(res.rows[0]?.o);
}

async function series(seriesId: string): Promise<CalendarEntry[]> {
  const res = await asUser(ana, () =>
    db.query(
      "select coalesce(jsonb_agg(calendar_entry_json(e) order by e.occurrence_on), '[]') as rows from calendar_entries e where series_id = $1",
      [seriesId],
    ),
  );
  return EntryJsonRows.parse(res.rows[0]?.rows);
}

async function entry(id: string): Promise<CalendarEntry> {
  return EntryJson.parse((await asUser(ana, () => db.query("select calendar_entry($1) as e", [id]))).rows[0]?.e);
}

const startOn = (e: CalendarEntry) => (e.when.kind === "allDay" ? e.when.first : wallClock(new Date(e.when.start), NY).day);
const clock = (e: CalendarEntry) => (e.when.kind === "timed" ? wallClock(new Date(e.when.start), NY).minutes : null);

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'ana2@lab.test'), ($2, 'ben2@lab.test'), ($3, 'cy@lab.test') on conflict do nothing", [
    ana,
    ben,
    cy,
  ]);
  labA = LabId.parse(CreateLabResult.parse((await asUser(ana, () => db.query("select create_lab('Repeats lab A') as id"))).rows[0]?.id));
  labB = LabId.parse(CreateLabResult.parse((await asUser(ben, () => db.query("select create_lab('Repeats lab B') as id"))).rows[0]?.id));
  await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [labA, cy]);
});

afterAll(async () => {
  await db.query("delete from labs where id = any($1)", [[labA, labB]]);
  await db.end();
});

describe("repeat rules", () => {
  it("land on the same days in SQL as in the editor", async () => {
    const first = day("2026-11-03");
    const rules: RepeatRule[] = [
      { every: "day", until: day("2026-11-20") },
      { every: "week", step: 1, weekdays: [2], until: day("2027-02-02") },
      { every: "week", step: 2, weekdays: [1, 4], until: day("2027-01-31") },
      { every: "week", step: 1, weekdays: [1, 2, 3, 4, 5], until: day("2026-12-31") },
      { every: "month", until: day("2027-11-03") },
    ];
    for (const rule of rules) {
      const arg = ruleArg(rule);
      const res = await db.query("select coalesce(array_agg(d::text order by d), '{}') as days from calendar_repeat_days($1, $2, $3, $4, $5) d", [
        arg.every,
        "step" in arg ? arg.step : 1,
        "weekdays" in arg ? arg.weekdays : [],
        first,
        rule.until,
      ]);
      expect(res.rows[0]?.days).toEqual(repeatDays(rule, first));
    }
    // A month on the 31st skips the months without one.
    expect(repeatDays({ every: "month", until: day("2027-03-31") }, day("2026-12-31"))).toEqual(["2026-12-31", "2027-01-31", "2027-03-31"]);
  });
});

describe("a repeating entry", () => {
  it("is one row per occurrence at the same wall-clock time across a DST change", async () => {
    const reader = await insert(ana, labA, draft("Plate reader", timed("2027-02-23", 10)));
    const out = await repeat(ana, reader, { every: "week", step: 1, weekdays: [2], until: day("2027-03-16") });
    expect(out.kind).toBe("saved");
    expect(out.entry?.repeat).toMatchObject({ firstOn: "2027-02-23", occurrenceOn: "2027-02-23", count: 4 });
    const all = await series(out.entry?.repeat?.seriesId ?? "");
    expect(all.map(startOn)).toEqual(["2027-02-23", "2027-03-02", "2027-03-09", "2027-03-16"]);
    // Clocks go forward on Mar 14; every one still starts at 10 am in New York.
    expect(all.map(clock)).toEqual([600, 600, 600, 600]);
    expect(all.map((e) => e.when.kind === "timed" && new Date(e.when.start).toISOString().slice(11, 16))).toEqual(["15:00", "15:00", "15:00", "14:00"]);
  });

  it("changes one occurrence alone, or spreads only what changed to all of them", async () => {
    const meeting = await insert(ana, labA, draft("Lab meeting", timed("2026-12-01", 13)));
    const made = await repeat(ana, meeting, { every: "week", step: 1, weekdays: [2], until: day("2026-12-22") });
    const seriesId = made.entry?.repeat?.seriesId ?? "";
    const [, second, third] = await series(seriesId);
    if (second === undefined || third === undefined) throw new Error("expected four occurrences");

    // This one: the third moves to 3 pm, the rest stay.
    const at3 = timed("2026-12-15", 15);
    const moved = await asUser(ana, () =>
      db.query("update calendar_entries set starts_at = $1, ends_at = $2 where id = $3 and updated_at = $4", [
        at3.kind === "timed" ? at3.start : null,
        at3.kind === "timed" ? at3.end : null,
        third.id,
        third.updatedAt,
      ]),
    );
    expect(moved.rowCount).toBe(1);

    // All of them, a new title from the second: every title changes, the third keeps 3 pm.
    const retitled = await asUser(ana, () =>
      db.query("select calendar_save_series($1, $2, $3) as o", [second.id, second.updatedAt, entryColumns({ ...draft("Group meeting", second.when) })]),
    );
    expect(Outcome.parse(retitled.rows[0]?.o).kind).toBe("saved");
    let all = await series(seriesId);
    expect(all.map((e) => e.title)).toEqual(["Group meeting", "Group meeting", "Group meeting", "Group meeting"]);
    expect(all.map(clock)).toEqual([780, 780, 900, 780]);

    // All of them, a new time and a day later from the first: everyone moves to Wednesday at 2 pm.
    const [first] = all;
    if (first === undefined) throw new Error("expected the first");
    await asUser(ana, () =>
      db.query("select calendar_save_series($1, $2, $3) as o", [first.id, first.updatedAt, entryColumns(draft("Group meeting", timed("2026-12-02", 14)))]),
    );
    all = await series(seriesId);
    expect(all.map(startOn)).toEqual(["2026-12-02", "2026-12-09", "2026-12-16", "2026-12-23"]);
    expect(all.map(clock)).toEqual([840, 840, 840, 840]);

    // A save on an older version is stale and changes nothing.
    const stale = await asUser(ana, () => db.query("select calendar_save_series($1, $2, $3) as o", [first.id, first.updatedAt, entryColumns(draft("Old", first.when))]));
    expect(Outcome.parse(stale.rows[0]?.o).kind).toBe("stale");
  });

  it("takes a new rule from one occurrence on, keeping earlier ones and one-off changes on kept days", async () => {
    const gel = await insert(ana, labA, draft("Gel run", { kind: "allDay", first: day("2027-01-04"), last: day("2027-01-04") }));
    const made = await repeat(ana, gel, { every: "week", step: 1, weekdays: [1], until: day("2027-02-01") });
    const oldSeries = made.entry?.repeat?.seriesId ?? "";
    const occurrences = await series(oldSeries);
    expect(occurrences.map(startOn)).toEqual(["2027-01-04", "2027-01-11", "2027-01-18", "2027-01-25", "2027-02-01"]);
    const [, jan11, , jan25] = occurrences;
    if (jan11 === undefined || jan25 === undefined) throw new Error("expected five");
    await asUser(ana, () => db.query("update calendar_entries set notes = 'Bring the 1% gel' where id = $1", [jan25.id]));

    // From Jan 11 on: Mondays and Thursdays until Jan 28.
    const split = await repeat(ana, jan11, { every: "week", step: 1, weekdays: [1, 4], until: day("2027-01-28") });
    const newSeries = split.entry?.repeat?.seriesId ?? "";
    expect(newSeries).not.toBe(oldSeries);
    expect((await series(oldSeries)).map(startOn)).toEqual(["2027-01-04"]);
    const later = await series(newSeries);
    expect(later.map(startOn)).toEqual(["2027-01-11", "2027-01-14", "2027-01-18", "2027-01-21", "2027-01-25", "2027-01-28"]);
    expect(later.find((e) => e.id === jan25.id)?.notes).toBe("Bring the 1% gel");
    expect((await entry(occurrences[0]?.id ?? "")).repeat).toMatchObject({ seriesId: oldSeries, rule: { until: "2027-01-04" }, count: 1 });

    // Doesn't repeat, from the first of the new ones: the rest go and it stands alone.
    const fresh = await entry(jan11.id);
    const stopped = await repeat(ana, fresh, null);
    expect(stopped.entry?.repeat).toBeNull();
    expect(await series(newSeries)).toEqual([]);
    expect((await db.query("select count(*)::int as n from calendar_series where id = $1", [newSeries])).rows[0]?.n).toBe(0);
  });

  it("deletes all its occurrences at once, and runs up to a year", async () => {
    const wash = await insert(ana, labA, draft("Wash the cold room", { kind: "allDay", first: day("2027-03-01"), last: day("2027-03-01") }));
    await expect(repeat(ana, wash, { every: "day", until: day("2028-03-02") })).rejects.toMatchObject({ code: "BL403" });
    const made = await repeat(ana, wash, { every: "day", until: day("2027-03-10") });
    expect(made.entry?.repeat?.count).toBe(10);
    const gone = await asUser(ana, () => db.query("select calendar_delete_series($1) as n", [wash.id]));
    expect(gone.rows[0]?.n).toBe(10);
    expect(await series(made.entry?.repeat?.seriesId ?? "")).toEqual([]);
  });

  it("is only another lab member's to change", async () => {
    const mine = await insert(ana, labA, draft("Only ours", timed("2027-04-01", 9)));
    await expect(repeat(ben, mine, { every: "day", until: day("2027-04-03") })).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(ben, () => db.query("select calendar_delete_series($1)", [mine.id]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("reminders", () => {
  it("are each member's own, show once when due, and spread to a series", async () => {
    const soon = new Date(Date.now() + 10 * 60_000);
    const later = new Date(Date.now() + 3 * 3_600_000);
    const centrifuge = await insert(ana, labA, draft("Centrifuge", { kind: "timed", start: soon.toISOString(), end: new Date(soon.getTime() + 3_600_000).toISOString() }));
    const seminar = await insert(ana, labA, draft("Seminar", { kind: "timed", start: later.toISOString(), end: new Date(later.getTime() + 3_600_000).toISOString() }));
    const set = (who: string, e: CalendarEntry, minutes: number[], all = false) =>
      asUser(who, () => db.query("select calendar_set_reminders($1, $2, $3) as e", [e.id, minutes, all]));
    expect(EntryJson.parse((await set(ana, centrifuge, [15, 1440])).rows[0]?.e).reminders).toEqual([15, 1440]);
    await set(ana, seminar, [15]);
    await set(cy, centrifuge, [5]);

    const due = async (who: string) =>
      z
        .array(z.object({ entry: EntryJson, minutes: z.number(), at: z.string() }))
        .parse((await asUser(who, () => db.query("select coalesce(jsonb_agg(j), '[]') as rows from calendar_due_reminders($1, $2) j", [labA, NY]))).rows[0]?.rows);
    const anaDue = await due(ana);
    // Fifteen minutes and a day before the centrifuge have both passed; the seminar's hasn't.
    expect(anaDue.map((d) => [d.entry.title, d.minutes])).toEqual([
      ["Centrifuge", 1440],
      ["Centrifuge", 15],
    ]);
    expect(anaDue[0]?.entry.reminders).toEqual([15, 1440]);
    // Cy's 5 minutes isn't due yet, and Cy never sees Ana's.
    expect(await due(cy)).toEqual([]);
    expect(await due(ben)).toEqual([]);

    for (const d of anaDue) await asUser(ana, () => db.query("select calendar_reminder_shown($1, $2, $3)", [d.entry.id, d.minutes, d.at]));
    expect(await due(ana)).toEqual([]);

    // A weekly series: a reminder on all of them is on every occurrence.
    const standup = await insert(ana, labA, draft("Standup", timed("2027-05-03", 9, 15)));
    const made = await repeat(ana, standup, { every: "week", step: 1, weekdays: [1], until: day("2027-05-24") });
    await set(ana, made.entry ?? standup, [10], true);
    expect((await series(made.entry?.repeat?.seriesId ?? "")).map((e) => e.reminders)).toEqual([[10], [10], [10], [10]]);
    await expect(set(ana, standup, [1, 2, 3, 4, 5, 6])).rejects.toMatchObject({ code: "22023" });
  });
});

describe("the feed", () => {
  const hash = (c: string) => c.repeat(64);
  const feed = async (h: string) => FeedJson.parse((await db.query("select calendar_feed($1) as f", [h])).rows[0]?.f);

  it("shows the lab's plans with the member's reminders until the address is replaced or they leave", async () => {
    await asUser(cy, () => db.query("select calendar_feed_reset($1, $2)", [labA, hash("a")]));
    const first = await feed(hash("a"));
    expect(first?.lab).toBe("Repeats lab A");
    const centrifuge = first?.entries.find((e) => e.title === "Centrifuge");
    expect(centrifuge?.reminders).toEqual([5]);
    const ics = feedIcs({ lab: first?.lab ?? "", entries: first?.entries ?? [], origin: "https://binary.test", now: new Date("2026-11-19T12:00:00Z") });
    expect(ics).toContain("SUMMARY:Centrifuge");
    expect(ics).toContain("TRIGGER:-PT5M");

    // Only Cy's own row is readable, and only its date.
    const own = await asUser(ana, () => db.query("select created_at from calendar_feeds"));
    expect(own.rows).toEqual([]);
    await expect(asUser(cy, () => db.query("select token_hash from calendar_feeds"))).rejects.toMatchObject({ code: "42501" });

    await asUser(cy, () => db.query("select calendar_feed_reset($1, $2)", [labA, hash("b")]));
    expect(await feed(hash("a"))).toBeNull();
    expect((await feed(hash("b")))?.entries.length).toBeGreaterThan(0);

    await db.query("delete from members where lab_id = $1 and user_id = $2", [labA, cy]);
    expect(await feed(hash("b"))).toBeNull();
    await expect(asUser(ana, () => db.query("select calendar_feed($1)", [hash("b")]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("notes on the calendar", () => {
  it("are one file on their first page's day", async () => {
    const source = await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/n') returning id", [labA]);
    const shas = ["a1", "a2", "a3", "a4"].map((s) => s.repeat(32));
    for (const [i, sha] of shas.entries()) {
      await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 1, 'image/jpeg', 'image') on conflict do nothing", [sha]);
      await db.query(
        `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
         values ($1, $2, $3, $4, $3, 1, $5, 'r', $6, 'indexed')`,
        [labA, source.rows[0]?.id, `page${i}.jpg`, `/Notebook/page${i}.jpg`, `2027-06-0${i + 1}T15:00:00Z`, sha],
      );
    }
    const note = await db.query("insert into notes (lab_id, reason, origin) values ($1, 'Uploaded together', 'batch:test') returning id", [labA]);
    for (const [i, sha] of shas.slice(0, 3).entries()) {
      await db.query("insert into note_pages (note_id, lab_id, sha256, position) values ($1, $2, $3, $4)", [note.rows[0]?.id, labA, sha, i + 1]);
    }
    const files = await asUser(ana, () => db.query("select sha256, day::text from calendar_files($1, '2027-06-01', '2027-06-07', $2) order by day", [labA, NY]));
    // Pages 2 and 3 fold into page 1 on Jun 1; the fourth file isn't in the note.
    expect(files.rows).toEqual([
      { sha256: shas[0], day: "2027-06-01" },
      { sha256: shas[3], day: "2027-06-04" },
    ]);
    // A week that holds only the later pages shows nothing for the note.
    const later = await asUser(ana, () => db.query("select sha256 from calendar_files($1, '2027-06-02', '2027-06-03', $2)", [labA, NY]));
    expect(later.rows).toEqual([]);
  });
});
