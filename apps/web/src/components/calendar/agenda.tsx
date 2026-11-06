"use client";

import { useState } from "react";
import { recordLine, type CalendarEntry, type RecordGroup } from "@/lib/calendar";
import { plansOn, whenLine } from "@/lib/calendar-edit";
import { formatCalendarDay, type CalendarDay } from "@/lib/calendar-time";
import { cn } from "@/lib/cn";
import { KindDot, useCalendar } from "./calendar-context";

// On a phone the month is a list: each day that has something, with today always in it.
export function Agenda({
  days: shown,
  plans,
  record,
}: {
  days: readonly CalendarDay[];
  plans: readonly CalendarEntry[];
  record: readonly RecordGroup[];
}) {
  const { timeZone, today, actions } = useCalendar();
  // Starts at today, as a schedule does, when today is in view; the days before wait behind a button.
  const [earlier, setEarlier] = useState(false);
  const all = shown
    .map((day) => ({ day, plans: plansOn(day, plans, timeZone), record: record.filter((g) => g.day === day) }))
    .filter((d) => d.day === today || d.plans.length > 0 || d.record.length > 0);
  const hidden = earlier || !shown.includes(today) ? 0 : all.findIndex((d) => d.day === today);
  const days = all.slice(hidden);

  if (days.length === 0) {
    return <p className="px-4 py-10 text-paragraph-medium text-content-tertiary">Nothing on the calendar yet.</p>;
  }
  return (
    <>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setEarlier(true)}
          className="flex min-h-11 w-full items-center border-t border-border-opaque px-4 text-left text-paragraph-small text-content-secondary"
        >
          Show {hidden === 1 ? "1 earlier day" : `${hidden} earlier days`}
        </button>
      ) : null}
      <ol className="divide-y divide-border-opaque border-t border-border-opaque">
        {days.map(({ day, plans: dayPlans, record: dayRecord }) => {
          const isToday = day === today;
          return (
            <li key={day} className="flex gap-4 px-4 py-4">
              <button
                type="button"
                onClick={() => actions.openDay(day)}
                aria-label={`${formatCalendarDay(day, "long")}${isToday ? ", today" : ""}`}
                aria-current={isToday ? "date" : undefined}
                className="flex w-11 shrink-0 flex-col items-center gap-0.5 pt-0.5"
              >
                <span className="text-paragraph-xsmall text-content-tertiary">{formatCalendarDay(day, "weekdayShort")}</span>
                <span
                  className={cn(
                    "grid size-8 place-items-center rounded-full text-label-medium tabular-nums",
                    isToday ? "bg-content-primary text-content-inverse-primary" : "text-content-primary",
                  )}
                >
                  {Number(day.slice(8))}
                </span>
              </button>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {dayPlans.length === 0 && dayRecord.length === 0 ? (
                  <p className="py-1.5 text-paragraph-small text-content-tertiary">Nothing planned</p>
                ) : null}
                {dayPlans.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => actions.openEntry(entry.id)}
                    className="flex min-h-11 min-w-0 flex-col justify-center rounded-lg bg-background-secondary px-3 py-1.5 text-left"
                  >
                    <span className="truncate text-label-medium text-content-primary">{entry.title}</span>
                    <span className="truncate text-paragraph-xsmall text-content-tertiary">
                      {[whenLine(entry.when, timeZone), entry.instrument?.name, entry.protocol?.title].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                ))}
                {dayRecord.map((g) => (
                  <button
                    key={`${g.kind}:${g.groupId ?? ""}`}
                    type="button"
                    onClick={() => actions.openDay(day)}
                    className="flex min-h-9 min-w-0 items-center gap-2 rounded-lg px-3 text-left text-paragraph-small text-content-secondary active:bg-background-secondary"
                  >
                    <KindDot kind={g.kind} />
                    <span className="truncate">{recordLine(g)}</span>
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
