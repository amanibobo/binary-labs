import { describe, expect, it } from "vitest";
import { CalendarEntryId } from "../calendar";
import { calendarSearch, calendarStart, isNewHistoryEntry, resolveStart, storedMode, type CalendarPlace } from "../calendar-start";
import { CalendarDay } from "../calendar-time";

const d = (s: string) => CalendarDay.parse(s);
const today = d("2026-11-05");
const entry = CalendarEntryId.parse("8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c0007");
const wide = { stored: null, phone: false, today };

describe("the address", () => {
  it("reads each of the four views, and leaves a missing or unknown one open", () => {
    for (const view of ["day", "week", "month", "year"] as const) expect(calendarStart({ view }).mode).toBe(view);
    expect(calendarStart({}).mode).toBeNull();
    expect(calendarStart({ view: "agenda" }).mode).toBeNull();
    expect(calendarStart({ view: ["week", "month"] }).mode).toBe("week");
  });

  it("reads the date, and what's open beside the grid", () => {
    expect(calendarStart({ date: "2026-11-05", entry })).toEqual({ mode: null, date: today, open: { kind: "entry", id: entry } });
    expect(calendarStart({ day: "2026-11-03" })).toEqual({ mode: null, date: d("2026-11-03"), open: { kind: "day", day: d("2026-11-03") } });
    expect(calendarStart({ date: "2026-13-45" }).date).toBeNull();
  });

  it("writes a place back the way it reads it", () => {
    const places: CalendarPlace[] = [
      { mode: "day", anchor: d("2027-03-02"), open: { kind: "none" } },
      { mode: "week", anchor: today, open: { kind: "entry", id: entry } },
      { mode: "month", anchor: today, open: { kind: "day", day: d("2026-11-03") } },
      { mode: "year", anchor: d("2027-01-01"), open: { kind: "none" } },
    ];
    for (const place of places) {
      const back = calendarStart(Object.fromEntries(new URLSearchParams(calendarSearch(place))));
      expect(resolveStart(back, wide)).toEqual(place);
    }
  });

  it("keeps other parameters and drops a stale day or entry", () => {
    const search = calendarSearch({ mode: "week", anchor: today, open: { kind: "none" } }, new URLSearchParams("day=2026-11-03&keep=1"));
    expect(new URLSearchParams(search).get("keep")).toBe("1");
    expect(new URLSearchParams(search).has("day")).toBe(false);
  });

  it("makes a new history step for a new view or date, not for the side peek", () => {
    const at: CalendarPlace = { mode: "month", anchor: today, open: { kind: "none" } };
    expect(isNewHistoryEntry(at, { ...at, mode: "day" })).toBe(true);
    expect(isNewHistoryEntry(at, { ...at, anchor: d("2026-12-01") })).toBe(true);
    expect(isNewHistoryEntry(at, { ...at, open: { kind: "day", day: today } })).toBe(false);
  });
});

describe("where the calendar opens", () => {
  it("prefers the address, then the last view used, then Day on a phone and Month elsewhere", () => {
    expect(resolveStart(calendarStart({ view: "week" }), { ...wide, stored: "year" }).mode).toBe("week");
    expect(resolveStart(calendarStart({}), { ...wide, stored: "year" }).mode).toBe("year");
    expect(resolveStart(calendarStart({}), wide).mode).toBe("month");
    expect(resolveStart(calendarStart({}), { ...wide, phone: true }).mode).toBe("day");
    expect(resolveStart(calendarStart({}), wide).anchor).toBe(today);
  });

  it("opens a linked entry or day in its month rather than the year", () => {
    const linked = resolveStart(calendarStart({ date: "2026-11-05", entry }), { ...wide, stored: "year" });
    expect(linked).toEqual({ mode: "month", anchor: today, open: { kind: "entry", id: entry } });
  });

  it("shows a linked day in the day view without a side peek over it", () => {
    expect(resolveStart(calendarStart({ view: "day", date: "2026-11-01", day: "2026-11-03" }), wide)).toEqual({
      mode: "day",
      anchor: d("2026-11-03"),
      open: { kind: "none" },
    });
  });

  it("only trusts a stored view it knows", () => {
    expect(storedMode("week")).toBe("week");
    expect(storedMode("agenda")).toBeNull();
    expect(storedMode(null)).toBeNull();
  });
});
