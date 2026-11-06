import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  CalendarDay,
  dayLength,
  daysBetween,
  formatTime,
  instantAt,
  minutesFromInput,
  monthGrid,
  startOfWeek,
  timeInputValue,
  todayIn,
  wallClock,
  weekOf,
} from "../calendar-time";

const d = (s: string) => CalendarDay.parse(s);
const NY = "America/New_York";

describe("days", () => {
  it("adds days and months across month and year ends", () => {
    expect(addDays(d("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addDays(d("2026-03-01"), -1)).toBe("2026-02-28");
    expect(addDays(d("2028-03-01"), -1)).toBe("2028-02-29");
    expect(addMonths(d("2026-01-31"), 1)).toBe("2026-02-01");
    expect(addMonths(d("2026-11-05"), -11)).toBe("2025-12-01");
    expect(daysBetween(d("2026-10-25"), d("2026-11-07"))).toBe(13);
  });

  it("starts weeks on Sunday", () => {
    expect(startOfWeek(d("2026-11-05"))).toBe("2026-11-01");
    expect(startOfWeek(d("2026-11-01"))).toBe("2026-11-01");
    expect(weekOf(d("2026-11-07"))).toEqual(
      ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"].map(d),
    );
  });

  it("lays a month out in four to six whole weeks", () => {
    const nov = monthGrid(d("2026-11-18"));
    expect(nov).toHaveLength(5);
    expect(nov[0]?.[0]).toBe("2026-11-01");
    expect(nov.at(-1)?.at(-1)).toBe("2026-12-05");
    // February 2026 starts on a Sunday and has 28 days: exactly four rows.
    expect(monthGrid(d("2026-02-10"))).toHaveLength(4);
    // August 2026 starts on a Saturday: six rows.
    const aug = monthGrid(d("2026-08-01"));
    expect(aug).toHaveLength(6);
    expect(aug[0]?.[0]).toBe("2026-07-26");
    expect(aug.flat().every((day, i, all) => i === 0 || daysBetween(all[i - 1] ?? day, day) === 1)).toBe(true);
  });

});

describe("the wall clock in a zone", () => {
  it("puts an evening in New York on its own day, not UTC's", () => {
    const evening = new Date("2026-11-05T02:00:00Z");
    expect(wallClock(evening, NY)).toEqual({ day: "2026-11-04", minutes: 21 * 60 });
    expect(wallClock(evening, "UTC")).toEqual({ day: "2026-11-05", minutes: 120 });
    expect(todayIn("Asia/Tokyo", evening)).toBe("2026-11-05");
  });

  it("round-trips ordinary times", () => {
    for (const tz of [NY, "Europe/Berlin", "Asia/Kolkata", "Australia/Adelaide", "UTC"]) {
      for (const minutes of [0, 61, 9 * 60 + 30, 23 * 60 + 59]) {
        expect(wallClock(instantAt(d("2026-07-14"), minutes, tz), tz)).toEqual({ day: "2026-07-14", minutes });
      }
    }
  });

  it("knows the day the clocks go back is 25 hours, and picks the first 1:30", () => {
    expect(dayLength(d("2026-11-01"), NY)).toBe(1500);
    expect(dayLength(d("2026-11-02"), NY)).toBe(1440);
    expect(instantAt(d("2026-11-01"), 90, NY).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    // Both 1:30s read back as 1:30.
    expect(wallClock(new Date("2026-11-01T06:30:00Z"), NY)).toEqual({ day: "2026-11-01", minutes: 90 });
    expect(instantAt(d("2026-11-01"), 3 * 60, NY).toISOString()).toBe("2026-11-01T08:00:00.000Z");
  });

  it("knows the day the clocks go forward is 23 hours, and moves a time in the gap on", () => {
    expect(dayLength(d("2026-03-08"), NY)).toBe(1380);
    expect(instantAt(d("2026-03-08"), 2 * 60 + 30, NY).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(wallClock(instantAt(d("2026-03-08"), 2 * 60 + 30, NY), NY).minutes).toBe(3 * 60 + 30);
    expect(instantAt(d("2026-03-08"), 3 * 60, NY).toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("formats times the short way", () => {
    expect(formatTime(new Date("2026-11-05T14:00:00Z"), NY)).toBe("9 AM");
    expect(formatTime(new Date("2026-11-05T19:30:00Z"), NY)).toBe("2:30 PM");
  });

  it("reads and writes time inputs", () => {
    expect(timeInputValue(9 * 60 + 5)).toBe("09:05");
    expect(minutesFromInput("23:45")).toBe(23 * 60 + 45);
    expect(minutesFromInput("24:00")).toBeNull();
    expect(minutesFromInput("9:00")).toBeNull();
  });
});
