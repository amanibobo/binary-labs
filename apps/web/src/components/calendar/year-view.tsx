"use client";

import { useState, type KeyboardEvent } from "react";
import { dayIn, monthsOf, yearOf } from "@/lib/calendar-nav";
import { addDays, addMonths, dayNumber, formatCalendarDay, monthGrid, sameMonth, weekOf, type CalendarDay } from "@/lib/calendar-time";
import type { DayActivity } from "@/lib/calendar-year";
import { countLine } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useCalendar } from "./calendar-context";

// Apple Calendar's year: twelve small months. A day with something on the record is softly
// shaded and a day with a plan has a dot under its number; today is in the filled circle.
// A month's name opens the month and a day opens that day. The days are one tab stop: the
// arrow keys move a day or a week, Page Up and Down a month.
export function YearView({
  year,
  activity,
  onMonth,
  onDay,
}: {
  year: number;
  activity: readonly DayActivity[];
  onMonth: (first: CalendarDay) => void;
  onDay: (day: CalendarDay) => void;
}) {
  const { today } = useCalendar();
  const byDay = new Map(activity.map((a) => [a.day, a]));
  const [focused, setFocused] = useState<CalendarDay>(yearOf(today) === year ? today : dayIn(year, 0, 1));
  const focusDay = yearOf(focused) === year ? focused : dayIn(year, 0, 1);

  function keys(event: KeyboardEvent<HTMLButtonElement>, day: CalendarDay) {
    const moves: Record<string, () => CalendarDay> = {
      ArrowLeft: () => addDays(day, -1),
      ArrowRight: () => addDays(day, 1),
      ArrowUp: () => addDays(day, -7),
      ArrowDown: () => addDays(day, 7),
      PageUp: () => dayIn(year, Math.max(0, Number(day.slice(5, 7)) - 2), dayNumber(day)),
      PageDown: () => dayIn(year, Math.min(11, Number(day.slice(5, 7))), dayNumber(day)),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const next = move();
    if (yearOf(next) !== year) return;
    setFocused(next);
    document.querySelector<HTMLElement>(`[data-year-day="${next}"]`)?.focus();
  }

  return (
    <div>
      <p className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-paragraph-xsmall text-content-tertiary">
        <span className="flex items-center gap-2">
          <span aria-hidden className="size-4 rounded-full bg-background-tertiary" />
          Something added
        </span>
        <span className="flex items-center gap-2">
          <span aria-hidden className="grid size-4 place-items-end justify-center pb-0.5">
            <span className="size-1 rounded-full bg-content-secondary" />
          </span>
          Something planned
        </span>
        <span>Pick a day or a month to open it.</span>
      </p>
      <div className="grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-3 sm:gap-x-8 sm:gap-y-8 lg:grid-cols-4 lg:gap-x-10">
        {monthsOf(year).map((first) => (
          <MiniMonth key={first} first={first} byDay={byDay} focusDay={focusDay} onMonth={onMonth} onDay={onDay} onKeys={keys} onFocusDay={setFocused} />
        ))}
      </div>
    </div>
  );
}

function MiniMonth({
  first,
  byDay,
  focusDay,
  onMonth,
  onDay,
  onKeys,
  onFocusDay,
}: {
  first: CalendarDay;
  byDay: ReadonlyMap<CalendarDay, DayActivity>;
  focusDay: CalendarDay;
  onMonth: (first: CalendarDay) => void;
  onDay: (day: CalendarDay) => void;
  onKeys: (event: KeyboardEvent<HTMLButtonElement>, day: CalendarDay) => void;
  onFocusDay: (day: CalendarDay) => void;
}) {
  const { today } = useCalendar();
  const name = formatCalendarDay(first, "month");
  const thisMonth = sameMonth(first, today);
  return (
    <section aria-label={name} className="min-w-0">
      <button
        type="button"
        onClick={() => onMonth(first)}
        className={cn(
          "-ml-1.5 rounded-md px-1.5 py-0.5 text-label-large transition-colors duration-150 hover:bg-background-secondary",
          thisMonth ? "text-content-primary" : "text-content-secondary hover:text-content-primary",
        )}
      >
        {formatCalendarDay(first, "monthLong")}
        <span className="sr-only">, open the month</span>
      </button>
      <div role="grid" aria-label={name} className="mt-2 grid grid-cols-7 text-center">
        <div role="row" className="contents">
          {weekOf(first).map((day) => (
            <span key={day} role="columnheader" aria-label={formatCalendarDay(day, "weekdayShort")} className="pb-1 text-paragraph-xsmall text-content-tertiary">
              {formatCalendarDay(day, "weekdayShort").slice(0, 1)}
            </span>
          ))}
        </div>
        {monthGrid(first).map((week) => (
          <div key={week[0]} role="row" className="contents">
            {week.map((day) =>
              sameMonth(day, first) ? (
                <DayDot key={day} day={day} activity={byDay.get(day)} focusable={day === focusDay} onDay={onDay} onKeys={onKeys} onFocusDay={onFocusDay} />
              ) : (
                <span key={day} role="gridcell" aria-hidden className="h-8" />
              ),
            )}
          </div>
        ))}
        {/* Every month takes six rows, so the grid of months stays even. */}
        {Array.from({ length: 6 - monthGrid(first).length }, (_, i) => (
          <span key={`pad-${addMonths(first, 1)}-${i}`} aria-hidden className="col-span-7 h-8" />
        ))}
      </div>
    </section>
  );
}

function DayDot({
  day,
  activity,
  focusable,
  onDay,
  onKeys,
  onFocusDay,
}: {
  day: CalendarDay;
  activity: DayActivity | undefined;
  focusable: boolean;
  onDay: (day: CalendarDay) => void;
  onKeys: (event: KeyboardEvent<HTMLButtonElement>, day: CalendarDay) => void;
  onFocusDay: (day: CalendarDay) => void;
}) {
  const { today } = useCalendar();
  const isToday = day === today;
  const plans = activity?.plans ?? 0;
  const items = activity?.items ?? 0;
  const said = [
    formatCalendarDay(day, "long"),
    isToday ? "today" : null,
    plans > 0 ? countLine(plans, "plan", "plans") : null,
    items > 0 ? `${countLine(items, "thing", "things")} added` : null,
  ].filter((s) => s !== null);
  return (
    <span role="gridcell" className="grid h-8 place-items-center">
      <button
        type="button"
        data-year-day={day}
        tabIndex={focusable ? 0 : -1}
        aria-label={said.join(", ")}
        aria-current={isToday ? "date" : undefined}
        onClick={() => onDay(day)}
        onKeyDown={(e) => onKeys(e, day)}
        onFocus={() => onFocusDay(day)}
        className={cn(
          "relative grid size-7 place-items-center rounded-full text-paragraph-xsmall tabular-nums outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-selected",
          isToday
            ? "bg-content-primary text-content-inverse-primary"
            : items > 0
              ? "bg-background-tertiary text-content-primary hover:bg-button-secondary-hover"
              : "text-content-secondary hover:bg-background-secondary hover:text-content-primary",
        )}
      >
        {dayNumber(day)}
        {plans > 0 ? (
          <span
            aria-hidden
            className={cn("absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full", isToday ? "bg-content-inverse-primary" : "bg-content-secondary")}
          />
        ) : null}
      </button>
    </span>
  );
}
