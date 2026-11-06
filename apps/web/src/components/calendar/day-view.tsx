"use client";

import type { CalendarEntry, CalendarFilters, RecordGroup } from "@/lib/calendar";
import { formatCalendarDay, type CalendarDay } from "@/lib/calendar-time";
import { useCalendar } from "./calendar-context";
import { DayPlanList, DayRecord } from "./day-record";
import type { PendingEntry } from "./inline-title";
import { TimeGrid } from "./week-view";

export const DAY_RECORD_ID = "calendar-day-record";

// One day: its hours, as the week draws them, beside the day's record in full. The record's
// lines over the hours scroll the list to their group.
export function DayView({
  day,
  plans,
  record,
  pending,
  filters,
}: {
  day: CalendarDay;
  plans: readonly CalendarEntry[];
  record: readonly RecordGroup[];
  pending: PendingEntry | null;
  filters: CalendarFilters;
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TimeGrid days={[day]} plans={plans} record={record} pending={pending} />
      </div>
      <div
        id={DAY_RECORD_ID}
        tabIndex={-1}
        className="min-h-0 w-[340px] shrink-0 overflow-y-auto border-t border-l border-border-opaque px-6 pt-4 pb-10 outline-none lg:w-[400px]"
      >
        <DayRecord key={day} day={day} filters={filters} />
      </div>
    </div>
  );
}

// On a phone a day is a list: its plans, then its record. The arrows in the header step a day.
export function PhoneDay({ day, plans, filters }: { day: CalendarDay; plans: readonly CalendarEntry[]; filters: CalendarFilters }) {
  const { today } = useCalendar();
  return (
    <div className="border-t border-border-opaque px-4 pt-4">
      <p className="text-paragraph-small text-content-tertiary">
        {formatCalendarDay(day, "weekday")}
        {day === today ? " · Today" : null}
      </p>
      <section aria-label="Plans" className="mt-4">
        <h3 className="text-label-medium text-content-secondary">Plans</h3>
        <DayPlanList day={day} plans={plans} />
      </section>
      <DayRecord key={day} day={day} filters={filters} className="mt-8" />
    </div>
  );
}
