import { describe, expect, it } from "vitest";
import { layoutSpans, monthRowLines } from "../calendar-layout";
import { CalendarDay } from "../calendar-time";

const d = (s: string) => CalendarDay.parse(s);

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
