import { describe, expect, it } from "vitest";
import {
  choiceOf,
  clampUntil,
  defaultUntil,
  reminderName,
  repeatChoices,
  repeatDays,
  repeatLine,
  RepeatJson,
  ruleName,
  startsLine,
  type RepeatRule,
} from "../calendar-repeat";
import { CalendarDay } from "../calendar-time";

const day = (s: string) => CalendarDay.parse(s);
const tue = day("2026-11-17");

describe("repeat rules in words", () => {
  it("say the rule the way the menu offers it", () => {
    const until = day("2027-02-16");
    expect(repeatChoices(tue, until).map((c) => c.label)).toEqual([
      "Doesn't repeat",
      "Every day",
      "Every weekday",
      "Every Tuesday",
      "Every 2 weeks on Tuesday",
      "Every month on the 17th",
    ]);
    expect(repeatLine({ every: "week", step: 1, weekdays: [2], until }, tue)).toBe("Every Tuesday until Feb 16");
    expect(ruleName({ every: "week", step: 2, weekdays: [1, 3, 5], until }, tue)).toBe("Every 2 weeks on Monday, Wednesday and Friday");
    expect(ruleName({ every: "month", until }, day("2026-11-22"))).toBe("Every month on the 22nd");
    expect(ruleName({ every: "month", until }, day("2026-11-11"))).toBe("Every month on the 11th");
  });

  it("finds which menu choice a rule is, and none for days picked by hand", () => {
    const until = day("2027-01-01");
    expect(choiceOf(null, tue)).toBe("none");
    expect(choiceOf({ every: "week", step: 1, weekdays: [1, 2, 3, 4, 5], until }, tue)).toBe("weekday");
    expect(choiceOf({ every: "week", step: 2, weekdays: [2], until }, tue)).toBe("week2");
    expect(choiceOf({ every: "week", step: 1, weekdays: [2, 4], until }, tue)).toBeNull();
  });

  it("ends a new repeat 13 weeks on, and never more than a year out or before it starts", () => {
    expect(defaultUntil(tue)).toBe("2027-02-16");
    expect(clampUntil(tue, day("2028-01-01"))).toBe("2027-11-18");
    expect(clampUntil(tue, day("2026-11-01"))).toBe(tue);
  });
});

describe("the days a rule lands on", () => {
  it("counts every other week from the week it starts, on each day picked", () => {
    const rule: RepeatRule = { every: "week", step: 2, weekdays: [2, 4], until: day("2026-12-17") };
    expect(repeatDays(rule, tue)).toEqual(["2026-11-17", "2026-11-19", "2026-12-01", "2026-12-03", "2026-12-15", "2026-12-17"]);
  });

  it("reads the database's rule and sorts its days", () => {
    const parsed = RepeatJson.parse({
      series_id: "7b1c2c39-5a4e-4c55-9d7b-0c3c1a7c0001",
      every: "week",
      step: 1,
      weekdays: [4, 2],
      first_on: "2026-11-17",
      until_on: "2027-02-16",
      occurrence_on: "2026-11-24",
      count: "26",
    });
    expect(parsed).toMatchObject({ rule: { every: "week", weekdays: [2, 4] }, occurrenceOn: "2026-11-24", count: 26 });
    expect(() => RepeatJson.parse({ ...parsed, series_id: parsed.seriesId, every: "week", step: 1, weekdays: [] })).toThrow();
  });
});

describe("reminders in words", () => {
  it("name each choice, with all-day ones at 9 am", () => {
    expect([0, 5, 15, 60, 120, 1440, 2880, 10_080].map((m) => reminderName(m, false))).toEqual([
      "At the start",
      "5 minutes before",
      "15 minutes before",
      "1 hour before",
      "2 hours before",
      "1 day before",
      "2 days before",
      "1 week before",
    ]);
    expect([0, 1440, 10_080].map((m) => reminderName(m, true))).toEqual(["On the day, 9 AM", "The day before, 9 AM", "1 week before"]);
  });

  it("say how soon it starts", () => {
    const now = Date.parse("2026-11-17T15:00:00Z");
    expect(startsLine(now + 15 * 60_000, now)).toBe("Starts in 15 minutes");
    expect(startsLine(now + 60 * 60_000, now)).toBe("Starts in 1 hour");
    expect(startsLine(now + 24 * 3_600_000, now)).toBe("Starts in 1 day");
    expect(startsLine(now - 5 * 60_000, now)).toBe("Started 5 minutes ago");
    expect(startsLine(now + 20_000, now)).toBe("Starting now");
  });
});
