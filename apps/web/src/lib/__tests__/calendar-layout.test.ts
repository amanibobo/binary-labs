import { describe, expect, it } from "vitest";
import { layoutDay, layoutSpans, monthRowLines, segmentOn } from "../calendar-layout";
import { CalendarDay } from "../calendar-time";

const d = (s: string) => CalendarDay.parse(s);
const NY = "America/New_York";
const seg = (id: string, start: number, end: number) => ({ id, start, end });
const h = (hours: number) => hours * 60;

describe("timed entries in a day", () => {
  it("gives an entry alone the whole width", () => {
    expect(layoutDay([seg("a", h(9), h(10))])).toEqual([{ id: "a", start: h(9), end: h(10), column: 0, columns: 1 }]);
  });

  it("splits overlapping entries and lets the next free one take a column back", () => {
    const placed = layoutDay([seg("a", h(9), h(11)), seg("b", h(10), h(12)), seg("c", h(11), h(12)), seg("d", h(13), h(14))]);
    const at = Object.fromEntries(placed.map((p) => [p.id, [p.column, p.columns]]));
    // a and b overlap; c starts when a ends and takes its column; d is on its own.
    expect(at).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
  });

  it("keeps a cluster as wide as its busiest moment, across a chain", () => {
    const placed = layoutDay([seg("a", h(8), h(12)), seg("b", h(9), h(10)), seg("c", h(9), h(10)), seg("e", h(11), h(13))]);
    const at = Object.fromEntries(placed.map((p) => [p.id, [p.column, p.columns]]));
    expect(at).toEqual({ a: [0, 3], b: [1, 3], c: [2, 3], e: [1, 3] });
  });

  it("puts the longer of two entries starting together first", () => {
    const placed = layoutDay([seg("short", h(9), h(9) + 30), seg("long", h(9), h(12))]);
    expect(placed.map((p) => p.id)).toEqual(["long", "short"]);
  });

  it("treats back-to-back entries as not overlapping, but a very short one as a line tall", () => {
    expect(layoutDay([seg("a", h(9), h(10)), seg("b", h(10), h(11))]).map((p) => p.columns)).toEqual([1, 1]);
    expect(layoutDay([seg("a", h(9), h(9) + 5), seg("b", h(9) + 10, h(10))]).map((p) => p.columns)).toEqual([2, 2]);
  });
});

describe("a timed entry's piece of a day", () => {
  it("splits an overnight entry at midnight", () => {
    const overnight = { start: "2026-11-05T03:00:00Z", end: "2026-11-05T13:00:00Z" }; // 10 pm to 8 am
    expect(segmentOn(overnight, d("2026-11-04"), NY)).toMatchObject({ start: h(22), end: h(24) });
    expect(segmentOn(overnight, d("2026-11-05"), NY)).toMatchObject({ start: 0, end: h(8) });
    expect(segmentOn(overnight, d("2026-11-06"), NY)).toBeNull();
  });

  it("draws the day the clocks go back by the wall clock", () => {
    // 1:00 EDT to 1:30 EST is 90 minutes, drawn from 1:00 to 1:30.
    const across = { start: "2026-11-01T05:00:00Z", end: "2026-11-01T06:30:00Z" };
    expect(segmentOn(across, d("2026-11-01"), NY)).toMatchObject({ start: h(1), end: h(1) + 30 });
    // An entry in the second 1:30 hour sits where the first one does.
    const second = { start: "2026-11-01T06:30:00Z", end: "2026-11-01T07:00:00Z" };
    expect(segmentOn(second, d("2026-11-01"), NY)).toMatchObject({ start: h(1) + 30, end: h(2) });
    // 1:50 EDT to 1:10 EST runs backwards on the wall clock; it's drawn from 1:50 at least a line tall.
    const backwards = { start: "2026-11-01T05:50:00Z", end: "2026-11-01T06:10:00Z" };
    expect(segmentOn(backwards, d("2026-11-01"), NY)).toMatchObject({ start: h(1) + 50, end: h(1) + 50 });
  });

  it("draws the day the clocks go forward without the missing hour", () => {
    // 1:30 EST to 3:30 EDT is one hour, drawn from 1:30 to 3:30.
    const across = { start: "2026-03-08T06:30:00Z", end: "2026-03-08T07:30:00Z" };
    expect(segmentOn(across, d("2026-03-08"), NY)).toMatchObject({ start: h(1) + 30, end: h(3) + 30 });
  });
});

describe("bars across a week row", () => {
  const week = d("2026-11-01");
  it("stacks overlapping bars in lanes and reuses a lane once it's free", () => {
    const placed = layoutSpans(
      [
        { id: "retreat", first: d("2026-11-04"), last: d("2026-11-06"), order: 0 },
        { id: "travel", first: d("2026-10-30"), last: d("2026-11-02"), order: 0 },
        { id: "gel", first: d("2026-11-05"), last: d("2026-11-05"), order: 540 },
        { id: "seminar", first: d("2026-11-02"), last: d("2026-11-02"), order: 600 },
        { id: "next", first: d("2026-11-07"), last: d("2026-11-10"), order: 0 },
      ],
      week,
    );
    const at = Object.fromEntries(placed.map((p) => [p.id, p]));
    expect(at.travel).toMatchObject({ column: 0, length: 2, lane: 0, startsBefore: true, endsAfter: false });
    expect(at.seminar).toMatchObject({ column: 1, length: 1, lane: 1 });
    expect(at.retreat).toMatchObject({ column: 3, length: 3, lane: 0 });
    expect(at.gel).toMatchObject({ column: 4, length: 1, lane: 1 });
    expect(at.next).toMatchObject({ column: 6, length: 1, lane: 0, endsAfter: true });
  });

  it("leaves out bars that miss the row", () => {
    expect(layoutSpans([{ id: "x", first: d("2026-11-08"), last: d("2026-11-09"), order: 0 }], week)).toEqual([]);
  });
});

describe("lines in a month row", () => {
  const lane = (id: string, column: number, length: number, l: number) => ({ id, column, length, lane: l, startsBefore: false, endsAfter: false });

  it("fits plans and the record when there's room", () => {
    const out = monthRowLines([lane("a", 0, 2, 0)], [2, 1, 0, 0, 0, 0, 0], 4);
    expect(out.lanes).toBe(1);
    expect(out.days.slice(0, 2)).toEqual([
      { records: 2, more: 0 },
      { records: 1, more: 0 },
    ]);
  });

  it("ends a full day in a count of what's hidden", () => {
    const out = monthRowLines([lane("a", 0, 1, 0), lane("b", 0, 1, 1)], [5, 0, 0, 0, 0, 0, 0], 4);
    expect(out.lanes).toBe(2);
    expect(out.days[0]).toEqual({ records: 1, more: 4 });
  });

  it("gives back a lane when lanes alone fill the day and something is hidden", () => {
    const lanes = [0, 1, 2, 3, 4].map((l) => lane(`p${l}`, 3, 1, l));
    const out = monthRowLines(lanes, [0, 0, 0, 1, 0, 0, 0], 4);
    expect(out.lanes).toBe(3);
    expect(out.days[3]).toEqual({ records: 0, more: 3 });
  });
});
