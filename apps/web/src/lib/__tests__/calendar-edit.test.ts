import { describe, expect, it } from "vitest";
import { recordLine, type RecordGroup } from "../calendar";
import { heldWindow, moveEnd, moveStart, shiftWhen, stretchWhen, toggleAllDay, whenLine } from "../calendar-edit";
import { CalendarDay, wallClock } from "../calendar-time";

const d = (s: string) => CalendarDay.parse(s);
const NY = "America/New_York";

describe("editing when an entry happens", () => {
  it("turns an all-day entry into an hour at 9 and back", () => {
    const timed = toggleAllDay({ kind: "allDay", first: d("2026-11-05"), last: d("2026-11-05") }, NY);
    expect(timed).toEqual({ kind: "timed", start: "2026-11-05T14:00:00.000Z", end: "2026-11-05T15:00:00.000Z" });
    expect(toggleAllDay(timed, NY)).toEqual({ kind: "allDay", first: "2026-11-05", last: "2026-11-05" });
  });

  it("keeps the length when the start moves, across the clocks going back", () => {
    const retreat = moveStart({ kind: "allDay", first: d("2026-11-06"), last: d("2026-11-08") }, { day: d("2026-11-10"), minutes: null }, NY);
    expect(retreat).toEqual({ kind: "allDay", first: "2026-11-10", last: "2026-11-12" });
    // Friday 10 pm for ten hours, moved to Saturday night: it ends at 7 am standard time.
    const dialysis = { kind: "timed" as const, start: "2026-10-31T02:00:00.000Z", end: "2026-10-31T12:00:00.000Z" };
    const moved = moveStart(dialysis, { day: d("2026-10-31"), minutes: null }, NY);
    expect(moved.kind === "timed" ? wallClock(new Date(moved.end), NY) : null).toEqual({ day: "2026-11-01", minutes: 7 * 60 });
  });

  it("never lets the end come before the start", () => {
    expect(moveEnd({ kind: "allDay", first: d("2026-11-06"), last: d("2026-11-08") }, { day: d("2026-11-01"), minutes: null }, NY)).toEqual({
      kind: "allDay",
      first: "2026-11-06",
      last: "2026-11-06",
    });
    const timed = { kind: "timed" as const, start: "2026-11-05T19:00:00.000Z", end: "2026-11-05T20:00:00.000Z" };
    expect(moveEnd(timed, { day: d("2026-11-05"), minutes: 13 * 60 }, NY)).toEqual({ ...timed, end: "2026-11-05T19:15:00.000Z" });
  });

  it("holds an all-day entry's days from midnight to midnight where the viewer is", () => {
    expect(heldWindow({ kind: "allDay", first: d("2026-11-01"), last: d("2026-11-01") }, NY)).toEqual({
      from: "2026-11-01T04:00:00.000Z",
      to: "2026-11-02T05:00:00.000Z",
    });
  });

  it("says when in a few words", () => {
    expect(whenLine({ kind: "allDay", first: d("2026-11-05"), last: d("2026-11-05") }, NY)).toBe("All day");
    expect(whenLine({ kind: "allDay", first: d("2026-11-06"), last: d("2026-11-08") }, NY)).toBe("Nov 6 – Nov 8");
    expect(whenLine({ kind: "timed", start: "2026-11-05T19:00:00Z", end: "2026-11-05T20:30:00Z" }, NY)).toBe("2 – 3:30 PM");
    expect(whenLine({ kind: "timed", start: "2026-11-06T03:00:00Z", end: "2026-11-06T12:00:00Z" }, NY)).toBe("Nov 5, 10 PM – Nov 6, 7 AM");
  });
});

describe("moving with a drag or the arrow keys", () => {
  const nine = { kind: "timed" as const, start: "2026-10-30T13:00:00.000Z", end: "2026-10-30T14:00:00.000Z" }; // Fri 9 am EDT
  it("keeps 9 am at 9 am when it moves across the clocks going back", () => {
    expect(shiftWhen(nine, { days: 3, minutes: 0 }, NY)).toEqual({
      kind: "timed",
      start: "2026-11-02T14:00:00.000Z",
      end: "2026-11-02T15:00:00.000Z",
    });
    expect(shiftWhen(nine, { days: 0, minutes: 15 }, NY)).toEqual({
      kind: "timed",
      start: "2026-10-30T13:15:00.000Z",
      end: "2026-10-30T14:15:00.000Z",
    });
  });

  it("stretches the end but never past the start", () => {
    expect(stretchWhen(nine, { days: 0, minutes: -60 }, NY)).toEqual({ ...nine, end: "2026-10-30T13:15:00.000Z" });
    const days = { kind: "allDay" as const, first: d("2026-11-06"), last: d("2026-11-06") };
    expect(stretchWhen(days, { days: 2, minutes: 0 }, NY)).toEqual({ ...days, last: "2026-11-08" });
    expect(stretchWhen(days, { days: -1, minutes: 0 }, NY)).toEqual(days);
    expect(shiftWhen(days, { days: -6, minutes: 0 }, NY)).toEqual({ kind: "allDay", first: "2026-10-31", last: "2026-10-31" });
  });
});

describe("a line of the record", () => {
  const group = (g: Partial<RecordGroup>): RecordGroup => ({
    day: d("2026-11-03"),
    kind: "file",
    groupId: null,
    groupName: null,
    items: 1,
    title: null,
    ...g,
  });
  it("counts by kind and names the group, or the one item", () => {
    expect(recordLine(group({ items: 12, groupId: "x", groupName: "P450 BM3" }))).toBe("12 files · P450 BM3");
    expect(recordLine(group({ kind: "instrument", items: 4, groupName: "SpectraMax" }))).toBe("4 files · SpectraMax");
    expect(recordLine(group({ kind: "upload", title: "Gel batch 5.jpg" }))).toBe("1 upload · Gel batch 5.jpg");
    expect(recordLine(group({ items: 3 }))).toBe("3 files");
    expect(recordLine(group({ kind: "protocol", groupName: "Bradford assay", items: 2 }))).toBe("Bradford assay · 2 saves");
    expect(recordLine(group({ kind: "chart", title: "Plate 7" }))).toBe("1 chart · Plate 7");
    expect(recordLine(group({ kind: "talk_through", items: 2 }))).toBe("2 talk-throughs");
  });
});
