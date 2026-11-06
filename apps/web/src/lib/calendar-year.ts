import { z } from "zod";
import { entryDays, type CalendarEntry, type RecordGroup } from "./calendar";
import { dayIn, monthsOf, startOfYear } from "./calendar-nav";
import { addDays, CalendarDay, daysBetween, type DayRange } from "./calendar-time";

// The year view's quiet marks: which days have plans and which have something on the record.

// calendar_record reads at most 62 days at a time, so a year is read two months at a time.
export function yearChunks(year: number): DayRange[] {
  const firsts = monthsOf(year).filter((_, month) => month % 2 === 0);
  return firsts.map((first, i) => ({ first, last: addDays(firsts[i + 1] ?? startOfYear(year + 1), -1) }));
}

export type DayActivity = { day: CalendarDay; plans: number; items: number };

// Per day of the year: how many plans touch it and how many things were added. A plan read in
// two chunks counts once; a plan running past the year's edge counts only its days inside.
export function yearActivity(at: {
  year: number;
  timeZone: string;
  record: readonly RecordGroup[];
  plans: readonly Pick<CalendarEntry, "id" | "when">[];
}): DayActivity[] {
  const first = startOfYear(at.year);
  const last = dayIn(at.year, 11, 31);
  const byDay = new Map<CalendarDay, DayActivity>();
  const on = (day: CalendarDay) => {
    let a = byDay.get(day);
    if (a === undefined) {
      a = { day, plans: 0, items: 0 };
      byDay.set(day, a);
    }
    return a;
  };
  const inYear = (day: CalendarDay) => daysBetween(first, day) >= 0 && daysBetween(day, last) >= 0;
  for (const group of at.record) if (inYear(group.day)) on(group.day).items += group.items;
  const seen = new Set<string>();
  for (const plan of at.plans) {
    if (seen.has(plan.id)) continue;
    seen.add(plan.id);
    const days = entryDays(plan.when, at.timeZone);
    const from = daysBetween(first, days.first) > 0 ? days.first : first;
    const to = daysBetween(days.last, last) > 0 ? days.last : last;
    for (let day = from; daysBetween(day, to) >= 0; day = addDays(day, 1)) on(day).plans += 1;
  }
  return [...byDay.values()].sort((a, b) => daysBetween(b.day, a.day));
}

export type YearResponse = { days: DayActivity[] };
export const YearResponse = z.object({
  days: z.array(z.object({ day: CalendarDay, plans: z.number().int().nonnegative(), items: z.number().int().nonnegative() })),
}) satisfies z.ZodType<YearResponse>;
