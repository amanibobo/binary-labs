import { describe, expect, it } from "vitest";
import { CalendarEntryId, type EntryWhen, type RecordGroup } from "../calendar";
import { CalendarDay, daysBetween, instantAt } from "../calendar-time";
import { yearActivity, yearChunks } from "../calendar-year";

const d = (s: string) => CalendarDay.parse(s);
const NY = "America/New_York";
let n = 0;
const plan = (when: EntryWhen, id?: string) => ({
  id: CalendarEntryId.parse(id ?? `8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c${String(++n).padStart(4, "0")}`),
  when,
});
const group = (day: string, items: number, kind: RecordGroup["kind"] = "file"): RecordGroup => ({
  day: d(day),
  kind,
  groupId: null,
  groupName: null,
  items,
  title: null,
});
const at = (day: string, hour: number) => instantAt(d(day), hour * 60, NY).toISOString();

describe("reading a year", () => {
  it("covers every day once, two months at a time, each within the database's 62 days", () => {
    for (const year of [2026, 2028]) {
      const chunks = yearChunks(year);
      expect(chunks).toHaveLength(6);
      expect(chunks[0]?.first).toBe(`${year}-01-01`);
      expect(chunks.at(-1)?.last).toBe(`${year}-12-31`);
      for (const [i, c] of chunks.entries()) {
        expect(daysBetween(c.first, c.last)).toBeLessThanOrEqual(62);
        const next = chunks[i + 1];
        if (next !== undefined) expect(daysBetween(c.last, next.first)).toBe(1);
      }
    }
  });
});

describe("a year's quiet marks", () => {
  it("adds up a day's record across its kinds and groups", () => {
    const out = yearActivity({ year: 2026, timeZone: NY, record: [group("2026-11-03", 342), group("2026-11-03", 2, "chart"), group("2026-11-04", 1)], plans: [] });
    expect(out).toEqual([
      { day: "2026-11-03", plans: 0, items: 344 },
      { day: "2026-11-04", plans: 0, items: 1 },
    ]);
  });

  it("marks every day a plan covers, and a timed plan on the viewer's days", () => {
    const out = yearActivity({
      year: 2026,
      timeZone: NY,
      record: [],
      plans: [
        plan({ kind: "allDay", first: d("2026-11-26"), last: d("2026-11-27") }),
        // 10 pm to 7 am runs into a second day.
        plan({ kind: "timed", start: at("2026-11-06", 22), end: at("2026-11-07", 7) }),
        // 8 pm in New York is the next day in UTC; it stays on the 9th here.
        plan({ kind: "timed", start: at("2026-11-09", 20), end: at("2026-11-09", 21) }),
      ],
    });
    expect(out.map((a) => [a.day, a.plans])).toEqual([
      ["2026-11-06", 1],
      ["2026-11-07", 1],
      ["2026-11-09", 1],
      ["2026-11-26", 1],
      ["2026-11-27", 1],
    ]);
  });

  it("counts a plan read in two chunks once, and plans and record on the same day together", () => {
    const meeting = plan({ kind: "timed", start: at("2026-03-02", 10), end: at("2026-03-02", 11) });
    const out = yearActivity({ year: 2026, timeZone: NY, record: [group("2026-03-02", 5)], plans: [meeting, meeting] });
    expect(out).toEqual([{ day: "2026-03-02", plans: 1, items: 5 }]);
  });

  it("keeps only the year's own days of a plan across New Year", () => {
    const winter = plan({ kind: "allDay", first: d("2026-12-30"), last: d("2027-01-02") });
    expect(yearActivity({ year: 2026, timeZone: NY, record: [], plans: [winter] }).map((a) => a.day)).toEqual(["2026-12-30", "2026-12-31"]);
    expect(yearActivity({ year: 2027, timeZone: NY, record: [group("2026-12-31", 3)], plans: [winter] }).map((a) => a.day)).toEqual([
      "2027-01-01",
      "2027-01-02",
    ]);
  });
});
