import { entryDays, type CalendarEntry, type EntryWhen } from "./calendar";
import {
  addDays,
  addMinutes,
  daysBetween,
  formatCalendarDay,
  formatTime,
  inRange,
  instantAt,
  shiftDays,
  startOfDay,
  wallClock,
  type CalendarDay,
} from "./calendar-time";

// The editor's date rules, kept pure: changing a start keeps the length, as Notion does, and
// an end can't come before its start.

const HOUR_MS = 3_600_000;
const MIN_TIMED_MS = 15 * 60_000;
// A new timed entry starts at 9 am on its first day and runs an hour.
const DEFAULT_START_MINUTES = 9 * 60;

export function allDayOn(day: CalendarDay): EntryWhen {
  return { kind: "allDay", first: day, last: day };
}

export function toggleAllDay(when: EntryWhen, timeZone: string): EntryWhen {
  if (when.kind === "timed") return { kind: "allDay", ...entryDays(when, timeZone) };
  const start = instantAt(when.first, DEFAULT_START_MINUTES, timeZone);
  return { kind: "timed", start: start.toISOString(), end: new Date(start.getTime() + HOUR_MS).toISOString() };
}

// A new start: the day, and for a timed entry the wall-clock minutes. The length stays.
export function moveStart(when: EntryWhen, to: { day: CalendarDay; minutes: number | null }, timeZone: string): EntryWhen {
  if (when.kind === "allDay") return { kind: "allDay", first: to.day, last: addDays(to.day, daysBetween(when.first, when.last)) };
  const length = Date.parse(when.end) - Date.parse(when.start);
  const minutes = to.minutes ?? wallClock(new Date(when.start), timeZone).minutes;
  const start = instantAt(to.day, minutes, timeZone);
  return { kind: "timed", start: start.toISOString(), end: new Date(start.getTime() + length).toISOString() };
}

// A new end. One before the start becomes the start's day, or a quarter hour after it.
export function moveEnd(when: EntryWhen, to: { day: CalendarDay; minutes: number | null }, timeZone: string): EntryWhen {
  if (when.kind === "allDay") return { kind: "allDay", first: when.first, last: daysBetween(when.first, to.day) < 0 ? when.first : to.day };
  const minutes = to.minutes ?? wallClock(new Date(when.end), timeZone).minutes;
  const end = instantAt(to.day, minutes, timeZone).getTime();
  const earliest = Date.parse(when.start) + MIN_TIMED_MS;
  return { kind: "timed", start: when.start, end: new Date(Math.max(end, earliest)).toISOString() };
}

// The moments an entry holds, for checking who else booked the instrument: an all-day entry
// holds its days from midnight to midnight where the viewer is.
export function heldWindow(when: EntryWhen, timeZone: string): { from: string; to: string } {
  if (when.kind === "timed") return { from: when.start, to: when.end };
  return { from: startOfDay(when.first, timeZone).toISOString(), to: startOfDay(addDays(when.last, 1), timeZone).toISOString() };
}

// A drag or an arrow key: whole days move on the wall clock, so 9 am stays 9 am across a DST
// change; minutes are real time.
export function shiftWhen(when: EntryWhen, by: { days: number; minutes: number }, timeZone: string): EntryWhen {
  if (when.kind === "allDay") return { kind: "allDay", first: addDays(when.first, by.days), last: addDays(when.last, by.days) };
  const length = Date.parse(when.end) - Date.parse(when.start);
  const start = addMinutes(shiftDays(new Date(when.start), by.days, timeZone), by.minutes);
  return { kind: "timed", start: start.toISOString(), end: new Date(start.getTime() + length).toISOString() };
}

// Moves only the end, keeping at least a day or a quarter hour.
export function stretchWhen(when: EntryWhen, by: { days: number; minutes: number }, timeZone: string): EntryWhen {
  if (when.kind === "allDay") {
    const last = addDays(when.last, by.days);
    return { kind: "allDay", first: when.first, last: daysBetween(when.first, last) < 0 ? when.first : last };
  }
  const end = addMinutes(shiftDays(new Date(when.end), by.days, timeZone), by.minutes).getTime();
  return { kind: "timed", start: when.start, end: new Date(Math.max(end, Date.parse(when.start) + MIN_TIMED_MS)).toISOString() };
}

export function plansOn(day: CalendarDay, plans: readonly CalendarEntry[], timeZone: string): CalendarEntry[] {
  return plans.filter((p) => inRange(day, entryDays(p.when, timeZone)));
}

// "All day", "Nov 6 – 8", "2 – 3 PM", "Nov 5, 10 PM – Nov 6, 7 AM".
export function whenLine(when: EntryWhen, timeZone: string): string {
  if (when.kind === "allDay") {
    if (when.first === when.last) return "All day";
    return `${formatCalendarDay(when.first, "monthDay")} – ${formatCalendarDay(when.last, "monthDay")}`;
  }
  const start = new Date(when.start);
  const end = new Date(when.end);
  const { first, last } = entryDays(when, timeZone);
  if (first === last) {
    const [from, to] = [formatTime(start, timeZone), formatTime(end, timeZone)];
    // "2 – 3:30 PM": the first half drops a meridiem the second repeats.
    return `${from.slice(-2) === to.slice(-2) ? from.slice(0, -3) : from} – ${to}`;
  }
  return `${formatCalendarDay(first, "monthDay")}, ${formatTime(start, timeZone)} – ${formatCalendarDay(wallClock(end, timeZone).day, "monthDay")}, ${formatTime(end, timeZone)}`;
}
