import { z } from "zod";

// Calendar days and wall-clock times for the lab calendar. A day ("2026-11-05") is a date that
// never shifts; a moment is an instant shown on the viewer's own clock. Day arithmetic runs on
// UTC midnights so it never meets a DST change; only instantAt and wallClock know about zones.

export const CalendarDay = z.iso.date().brand<"CalendarDay">();
export type CalendarDay = z.infer<typeof CalendarDay>;

const DAY_MS = 86_400_000;
export const MINUTES_PER_DAY = 1440;

function utcMidnight(day: CalendarDay): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function dayFromUtc(ms: number): CalendarDay {
  return CalendarDay.parse(new Date(ms).toISOString().slice(0, 10));
}

export function addDays(day: CalendarDay, n: number): CalendarDay {
  return dayFromUtc(utcMidnight(day) + n * DAY_MS);
}

// b minus a, in days.
export function daysBetween(a: CalendarDay, b: CalendarDay): number {
  return Math.round((utcMidnight(b) - utcMidnight(a)) / DAY_MS);
}

// 0 is Sunday. Weeks start on Sunday, as they do for a US lab.
export function weekday(day: CalendarDay): number {
  return new Date(utcMidnight(day)).getUTCDay();
}

export function startOfWeek(day: CalendarDay): CalendarDay {
  return addDays(day, -weekday(day));
}

export function weekOf(day: CalendarDay): CalendarDay[] {
  const first = startOfWeek(day);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

export function startOfMonth(day: CalendarDay): CalendarDay {
  return CalendarDay.parse(`${day.slice(0, 8)}01`);
}

export function addMonths(day: CalendarDay, n: number): CalendarDay {
  const d = new Date(utcMidnight(startOfMonth(day)));
  d.setUTCMonth(d.getUTCMonth() + n);
  return dayFromUtc(d.getTime());
}

export function sameMonth(a: CalendarDay, b: CalendarDay): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

// The weeks a month grid shows, Sunday first: four to six rows, each of seven days, with the
// days of the months on either side filling the first and last rows.
export function monthGrid(day: CalendarDay): CalendarDay[][] {
  const first = startOfMonth(day);
  const last = addDays(addMonths(first, 1), -1);
  const weeks: CalendarDay[][] = [];
  for (let start = startOfWeek(first); daysBetween(start, last) >= 0; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  }
  return weeks;
}

export type DayRange = { first: CalendarDay; last: CalendarDay };

export function inRange(day: CalendarDay, range: DayRange): boolean {
  return daysBetween(range.first, day) >= 0 && daysBetween(day, range.last) >= 0;
}

// The wall clock in a zone: the day and the minutes since that day's midnight.
export type WallTime = { day: CalendarDay; minutes: number };

const partFormats = new Map<string, Intl.DateTimeFormat>();

function partsFormat(timeZone: string): Intl.DateTimeFormat {
  let format = partFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partFormats.set(timeZone, format);
  }
  return format;
}

function wallParts(instant: Date, timeZone: string): { day: CalendarDay; seconds: number } {
  const parts: Record<string, string> = {};
  for (const p of partsFormat(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  const day = CalendarDay.parse(`${parts.year}-${parts.month}-${parts.day}`);
  const seconds = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return { day, seconds };
}

export function wallClock(instant: Date, timeZone: string): WallTime {
  const { day, seconds } = wallParts(instant, timeZone);
  return { day, minutes: Math.floor(seconds / 60) };
}

// Minutes the zone is ahead of UTC at an instant (-300 in New York in winter).
function offsetMinutes(ms: number, timeZone: string): number {
  const { day, seconds } = wallParts(new Date(ms), timeZone);
  const asUtc = utcMidnight(day) + seconds * 1000;
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

// The instant a wall-clock time names. When the clocks go back the time happens twice and this
// is the first; when they go forward a time in the gap moves on by the gap (2:30 becomes 3:30).
export function instantAt(day: CalendarDay, minutes: number, timeZone: string): Date {
  const local = utcMidnight(day) + minutes * 60_000;
  const offsets = new Set([offsetMinutes(local - DAY_MS, timeZone), offsetMinutes(local + DAY_MS, timeZone)]);
  const valid = [...offsets].map((o) => local - o * 60_000).filter((ms) => offsetMinutes(ms, timeZone) === (local - ms) / 60_000);
  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(local - Math.min(...offsets) * 60_000);
}

export function startOfDay(day: CalendarDay, timeZone: string): Date {
  return instantAt(day, 0, timeZone);
}

// How long a day is where the viewer is: 1380 minutes when the clocks go forward, 1500 back.
export function dayLength(day: CalendarDay, timeZone: string): number {
  return (startOfDay(addDays(day, 1), timeZone).getTime() - startOfDay(day, timeZone).getTime()) / 60_000;
}

export function todayIn(timeZone: string, now: Date = new Date()): CalendarDay {
  return wallClock(now, timeZone).day;
}

export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Formatting, in the viewer's zone. "9 AM", "9:30 AM".
const timeFormats = new Map<string, Intl.DateTimeFormat>();

export function formatTime(instant: Date, timeZone: string): string {
  let format = timeFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
    timeFormats.set(timeZone, format);
  }
  return format.format(instant).replace(":00", "");
}

const DAY_FORMATS = {
  month: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
  monthShort: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }),
  long: new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }),
  medium: new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }),
  weekdayShort: new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }),
  monthDay: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
} as const;

export type DayFormat = keyof typeof DAY_FORMATS;

export function formatCalendarDay(day: CalendarDay, format: DayFormat): string {
  return DAY_FORMATS[format].format(new Date(utcMidnight(day)));
}

export function dayNumber(day: CalendarDay): number {
  return Number(day.slice(8, 10));
}

// "<input type=time>" values.
export function timeInputValue(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function minutesFromInput(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes < MINUTES_PER_DAY ? minutes : null;
}
