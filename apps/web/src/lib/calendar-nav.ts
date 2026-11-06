import type { CalendarMode } from "./calendar-start";
import {
  addDays,
  addMonths,
  CalendarDay,
  formatCalendarDay,
  formatWeekTitle,
  monthGrid,
  weekOf,
  type DayRange,
} from "./calendar-time";

// Getting around the calendar: what each view shows, its title, the arrows' steps, and the
// title's month and year picker. Pure, so the date math is tested without a browser.

// The years the picker and the arrows reach.
export const MIN_YEAR = 1970;
export const MAX_YEAR = 2100;

export function yearOf(day: CalendarDay): number {
  return Number(day.slice(0, 4));
}

// 0 is January.
export function monthOf(day: CalendarDay): number {
  return Number(day.slice(5, 7)) - 1;
}

export function clampYear(year: number): number {
  return Math.min(MAX_YEAR, Math.max(MIN_YEAR, Math.trunc(year)));
}

// A year typed into the picker: four digits in reach, or nothing.
export function parseYear(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{4}$/.test(trimmed)) return null;
  const year = Number(trimmed);
  return year >= MIN_YEAR && year <= MAX_YEAR ? year : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// A day of a month, pulled back to the month's last day when it has fewer (Jan 31 → Feb 28).
export function dayIn(year: number, month: number, dayOfMonth: number): CalendarDay {
  const day = Math.min(Math.max(1, dayOfMonth), daysInMonth(year, month));
  return CalendarDay.parse(`${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

export function startOfYear(year: number): CalendarDay {
  return dayIn(year, 0, 1);
}

// The twelve months of a year, each as its first day.
export function monthsOf(year: number): CalendarDay[] {
  return Array.from({ length: 12 }, (_, month) => dayIn(year, month, 1));
}

// The days a view shows: one, a week from Sunday, a month's whole weeks, or the year.
export function viewRange(mode: CalendarMode, anchor: CalendarDay): DayRange {
  switch (mode) {
    case "day":
      return { first: anchor, last: anchor };
    case "week": {
      const days = weekOf(anchor);
      return { first: days[0] ?? anchor, last: days.at(-1) ?? anchor };
    }
    case "month": {
      const days = monthGrid(anchor).flat();
      return { first: days[0] ?? anchor, last: days.at(-1) ?? anchor };
    }
    case "year": {
      const year = yearOf(anchor);
      return { first: startOfYear(year), last: dayIn(year, 11, 31) };
    }
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

// The arrows: a day, a week, a month or a year at a time, never past the years in reach.
export function stepAnchor(mode: CalendarMode, anchor: CalendarDay, n: number): CalendarDay {
  let next: CalendarDay;
  switch (mode) {
    case "day":
      next = addDays(anchor, n);
      break;
    case "week":
      next = addDays(anchor, 7 * n);
      break;
    case "month":
      next = addMonths(anchor, n);
      break;
    case "year":
      next = dayIn(yearOf(anchor) + n, monthOf(anchor), Number(anchor.slice(8, 10)));
      break;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
  const year = yearOf(next);
  return year < MIN_YEAR || year > MAX_YEAR ? anchor : next;
}

// Picking a month in the title's picker. The view stays and the day of the month carries over
// where it can; the year view has no single month to show, so it opens the month.
export function jumpToMonth(at: { mode: CalendarMode; anchor: CalendarDay }, to: { year: number; month: number }): { mode: CalendarMode; anchor: CalendarDay } {
  const year = clampYear(to.year);
  const month = Math.min(11, Math.max(0, Math.trunc(to.month)));
  if (at.mode === "year" || at.mode === "month") return { mode: "month", anchor: dayIn(year, month, 1) };
  return { mode: at.mode, anchor: dayIn(year, month, Number(at.anchor.slice(8, 10))) };
}

// The header: "November 5, 2026", "November 2026", "Oct – Nov 2026", "2026".
export function viewTitle(mode: CalendarMode, anchor: CalendarDay): string {
  switch (mode) {
    case "day":
      return formatCalendarDay(anchor, "date");
    case "week": {
      const range = viewRange("week", anchor);
      return formatWeekTitle(range.first, range.last);
    }
    case "month":
      return formatCalendarDay(anchor, "month");
    case "year":
      return String(yearOf(anchor));
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

export const MODE_NAMES = { day: "Day", week: "Week", month: "Month", year: "Year" } as const satisfies Record<CalendarMode, string>;
export const MODE_KEYS = { day: "D", week: "W", month: "M", year: "Y" } as const satisfies Record<CalendarMode, string>;

export function stepName(mode: CalendarMode, direction: "previous" | "next"): string {
  const unit = MODE_NAMES[mode].toLowerCase();
  return direction === "previous" ? `Previous ${unit}` : `Next ${unit}`;
}

// The picker's keys over its 3×4 months: arrows move a month or a row, running on into the
// next or last year; Page Up and Down move a year; Home and End go to January and December.
export type PickerMonth = { year: number; month: number };

export function pickerStep(at: PickerMonth, key: string): PickerMonth | null {
  if (key === "Home") return { year: at.year, month: 0 };
  if (key === "End") return { year: at.year, month: 11 };
  const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3, PageUp: -12, PageDown: 12 };
  const delta = deltas[key];
  if (delta === undefined) return null;
  const index = at.year * 12 + at.month + delta;
  const year = Math.floor(index / 12);
  if (year < MIN_YEAR || year > MAX_YEAR) return at;
  return { year, month: index - year * 12 };
}
