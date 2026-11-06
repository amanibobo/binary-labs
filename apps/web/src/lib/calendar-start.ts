import { z } from "zod";
import { CalendarEntryId, type EntryWhen } from "./calendar";
import { CalendarDay } from "./calendar-time";

// Where the calendar opens and how the address follows it: ?view=day|week|month|year&date=,
// with day= or entry= for what's open beside the grid.

export const CALENDAR_MODES = ["day", "week", "month", "year"] as const;
export const CalendarMode = z.enum(CALENDAR_MODES);
export type CalendarMode = z.infer<typeof CalendarMode>;

// What's open beside the grid: a day, an entry, or a new entry waiting for its title.
export type CalendarOpen =
  { kind: "none" } | { kind: "day"; day: CalendarDay } | { kind: "entry"; id: CalendarEntryId } | { kind: "new"; when: EntryWhen };

// What the address asked for. A missing view is left to resolveStart.
export type CalendarStart = { mode: CalendarMode | null; date: CalendarDay | null; open: CalendarOpen };

// What's on screen.
export type CalendarPlace = { mode: CalendarMode; anchor: CalendarDay; open: CalendarOpen };

const Param = z.union([z.string(), z.array(z.string()), z.undefined(), z.null()]).transform((v) => (Array.isArray(v) ? v[0] : (v ?? undefined)));

export function calendarStart(params: Record<string, string | string[] | undefined>): CalendarStart {
  const one = (key: string) => Param.parse(params[key]);
  const mode = CalendarMode.safeParse(one("view"));
  const date = CalendarDay.safeParse(one("date"));
  const day = CalendarDay.safeParse(one("day"));
  const entry = CalendarEntryId.safeParse(one("entry"));
  return {
    mode: mode.success ? mode.data : null,
    date: date.success ? date.data : day.success ? day.data : null,
    open: entry.success ? { kind: "entry", id: entry.data } : day.success ? { kind: "day", day: day.data } : { kind: "none" },
  };
}

// The address's view, else the one this person used last, else Day on a phone and Month on a
// wider screen. The year has no side peek, so a link to an entry or a day opens its month; in
// the day view a day's record is already beside the grid, so that day is simply shown.
export function resolveStart(start: CalendarStart, at: { stored: CalendarMode | null; phone: boolean; today: CalendarDay }): CalendarPlace {
  let mode = start.mode ?? at.stored ?? (at.phone ? "day" : "month");
  if (mode === "year" && start.open.kind !== "none") mode = "month";
  const anchor = start.date ?? at.today;
  if (mode === "day" && start.open.kind === "day") return { mode, anchor: start.open.day, open: { kind: "none" } };
  return { mode, anchor, open: start.open };
}

// The query string for a place, keeping any other parameters already there.
export function calendarSearch(place: CalendarPlace, current: URLSearchParams = new URLSearchParams()): string {
  const params = new URLSearchParams(current);
  params.set("view", place.mode);
  params.set("date", place.anchor);
  params.delete("day");
  params.delete("entry");
  if (place.open.kind === "day") params.set("day", place.open.day);
  if (place.open.kind === "entry") params.set("entry", place.open.id);
  return params.toString();
}

// A new view or date is a step back and forward can retrace; opening and closing the side peek
// only rewrites the current one.
export function isNewHistoryEntry(from: CalendarPlace, to: CalendarPlace): boolean {
  return from.mode !== to.mode || from.anchor !== to.anchor;
}

// The last view, kept per person in this browser.
export function viewStorageKey(viewer: string): string {
  return `binary.calendar.view.${viewer}`;
}

export function storedMode(raw: string | null): CalendarMode | null {
  const parsed = CalendarMode.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
