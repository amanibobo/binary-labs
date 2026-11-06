import { z } from "zod";
import { CalendarEntryId, type EntryWhen } from "./calendar";
import { CalendarDay } from "./calendar-time";

export type CalendarMode = "month" | "week";

// What's open beside the grid: a day, an entry, or a new entry waiting for its title.
export type CalendarOpen =
  | { kind: "none" }
  | { kind: "day"; day: CalendarDay }
  | { kind: "entry"; id: CalendarEntryId }
  | { kind: "new"; when: EntryWhen };

export type CalendarStart = { mode: CalendarMode; date: CalendarDay | null; open: CalendarOpen };

const Param = z.union([z.string(), z.array(z.string()), z.undefined()]).transform((v) => (Array.isArray(v) ? v[0] : v));

// ?view=month|week&date=YYYY-MM-DD, with day= or entry= for what's open.
export function calendarStart(params: Record<string, string | string[] | undefined>): CalendarStart {
  const one = (key: string) => Param.parse(params[key]);
  const date = CalendarDay.safeParse(one("date"));
  const day = CalendarDay.safeParse(one("day"));
  const entry = CalendarEntryId.safeParse(one("entry"));
  return {
    mode: one("view") === "week" ? "week" : "month",
    date: date.success ? date.data : day.success ? day.data : null,
    open: entry.success ? { kind: "entry", id: entry.data } : day.success ? { kind: "day", day: day.data } : { kind: "none" },
  };
}
