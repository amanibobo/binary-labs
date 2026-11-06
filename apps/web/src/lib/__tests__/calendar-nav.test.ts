import { describe, expect, it } from "vitest";
import { clampYear, dayIn, jumpToMonth, MAX_YEAR, MIN_YEAR, parseYear, pickerStep, stepAnchor, viewRange, viewTitle } from "../calendar-nav";
import { CalendarDay } from "../calendar-time";

const d = (s: string) => CalendarDay.parse(s);

describe("what each view shows", () => {
  it("covers a day, a week from Sunday, a month's whole weeks, and the year", () => {
    expect(viewRange("day", d("2026-11-05"))).toEqual({ first: d("2026-11-05"), last: d("2026-11-05") });
    expect(viewRange("week", d("2026-11-05"))).toEqual({ first: d("2026-11-01"), last: d("2026-11-07") });
    expect(viewRange("month", d("2026-11-05"))).toEqual({ first: d("2026-11-01"), last: d("2026-12-05") });
    expect(viewRange("year", d("2026-11-05"))).toEqual({ first: d("2026-01-01"), last: d("2026-12-31") });
  });

  it("titles each view", () => {
    expect(viewTitle("day", d("2026-11-05"))).toBe("November 5, 2026");
    expect(viewTitle("week", d("2026-11-05"))).toBe("November 2026");
    expect(viewTitle("week", d("2026-12-30"))).toBe("Dec 2026 – Jan 2027");
    expect(viewTitle("month", d("2026-11-05"))).toBe("November 2026");
    expect(viewTitle("year", d("2026-11-05"))).toBe("2026");
  });
});

describe("the arrows", () => {
  it("step a day, a week, a month or a year", () => {
    expect(stepAnchor("day", d("2026-11-30"), 1)).toBe("2026-12-01");
    expect(stepAnchor("week", d("2026-11-05"), -1)).toBe("2026-10-29");
    expect(stepAnchor("month", d("2026-01-31"), 1)).toBe("2026-02-01");
    // Feb 29 has no twin a year on.
    expect(stepAnchor("year", d("2028-02-29"), 1)).toBe("2029-02-28");
  });

  it("stop at the years in reach", () => {
    expect(stepAnchor("year", d(`${MAX_YEAR}-06-01`), 1)).toBe(`${MAX_YEAR}-06-01`);
    expect(stepAnchor("month", d(`${MAX_YEAR}-12-01`), 1)).toBe(`${MAX_YEAR}-12-01`);
    expect(stepAnchor("day", d(`${MIN_YEAR}-01-01`), -1)).toBe(`${MIN_YEAR}-01-01`);
  });
});

describe("the title's month and year picker", () => {
  it("keeps the view and the day of the month where it can", () => {
    expect(jumpToMonth({ mode: "day", anchor: d("2026-11-05") }, { year: 2027, month: 2 })).toEqual({ mode: "day", anchor: "2027-03-05" });
    expect(jumpToMonth({ mode: "week", anchor: d("2026-01-31") }, { year: 2026, month: 1 })).toEqual({ mode: "week", anchor: "2026-02-28" });
    expect(jumpToMonth({ mode: "week", anchor: d("2027-01-31") }, { year: 2028, month: 1 })).toEqual({ mode: "week", anchor: "2028-02-29" });
    expect(jumpToMonth({ mode: "month", anchor: d("2026-11-05") }, { year: 2027, month: 2 })).toEqual({ mode: "month", anchor: "2027-03-01" });
  });

  it("opens the month from the year view, which has no single month to show", () => {
    expect(jumpToMonth({ mode: "year", anchor: d("2026-11-05") }, { year: 2027, month: 2 })).toEqual({ mode: "month", anchor: "2027-03-01" });
  });

  it("holds the year in reach", () => {
    expect(clampYear(1900)).toBe(MIN_YEAR);
    expect(clampYear(3000)).toBe(MAX_YEAR);
    expect(jumpToMonth({ mode: "month", anchor: d("2026-11-05") }, { year: 9999, month: 0 }).anchor).toBe(`${MAX_YEAR}-01-01`);
  });

  it("reads a typed year only when it's four digits in reach", () => {
    expect(parseYear("2027")).toBe(2027);
    expect(parseYear(" 2027 ")).toBe(2027);
    expect(parseYear("202")).toBeNull();
    expect(parseYear("1969")).toBeNull();
    expect(parseYear("2101")).toBeNull();
    expect(parseYear("20x7")).toBeNull();
  });

  it("moves over the months with the arrow keys, into the next and last year", () => {
    expect(pickerStep({ year: 2026, month: 10 }, "ArrowRight")).toEqual({ year: 2026, month: 11 });
    expect(pickerStep({ year: 2026, month: 11 }, "ArrowRight")).toEqual({ year: 2027, month: 0 });
    expect(pickerStep({ year: 2026, month: 1 }, "ArrowUp")).toEqual({ year: 2025, month: 10 });
    expect(pickerStep({ year: 2026, month: 10 }, "ArrowDown")).toEqual({ year: 2027, month: 1 });
    expect(pickerStep({ year: 2026, month: 4 }, "PageDown")).toEqual({ year: 2027, month: 4 });
    expect(pickerStep({ year: 2026, month: 4 }, "Home")).toEqual({ year: 2026, month: 0 });
    expect(pickerStep({ year: 2026, month: 4 }, "End")).toEqual({ year: 2026, month: 11 });
    expect(pickerStep({ year: 2026, month: 4 }, "a")).toBeNull();
  });

  it("stays put at the edge of the years in reach", () => {
    expect(pickerStep({ year: MAX_YEAR, month: 11 }, "ArrowRight")).toEqual({ year: MAX_YEAR, month: 11 });
    expect(pickerStep({ year: MIN_YEAR, month: 3 }, "PageUp")).toEqual({ year: MIN_YEAR, month: 3 });
  });

  it("pulls a day back to the end of a shorter month", () => {
    expect(dayIn(2026, 3, 31)).toBe("2026-04-30");
    expect(dayIn(2026, 1, 30)).toBe("2026-02-28");
  });
});
