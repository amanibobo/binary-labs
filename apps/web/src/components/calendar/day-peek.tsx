"use client";

import { useId } from "react";
import type { CalendarEntry, CalendarFilters } from "@/lib/calendar";
import { formatCalendarDay, type CalendarDay } from "@/lib/calendar-time";
import { PlusIcon } from "../icons/base-web";
import { Button } from "../ui/button";
import { DayPlanList, DayRecord } from "./day-record";
import { SidePeek } from "./side-peek";

// A day opened from the month or week: its plans, then its record. "Day view" opens the same
// day with its hours.
export function DayPeek({
  day,
  filters,
  plans,
  onClose,
  onNewEntry,
  onDayView,
}: {
  day: CalendarDay;
  filters: CalendarFilters;
  plans: readonly CalendarEntry[];
  onClose: () => void;
  onNewEntry: () => void;
  onDayView: () => void;
}) {
  const headingId = useId();
  return (
    <SidePeek
      labelledBy={headingId}
      onClose={onClose}
      tools={
        <Button variant="tertiary" size="compact" className="text-content-secondary" onClick={onDayView}>
          Day view
        </Button>
      }
    >
      <h2 id={headingId} className="text-heading-medium">
        {formatCalendarDay(day, "long")}
      </h2>

      <section aria-label="Plans" className="mt-6">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-label-medium text-content-secondary">Plans</h3>
          <Button variant="tertiary" size="compact" className="-mr-2 text-content-secondary" onClick={onNewEntry}>
            <PlusIcon className="size-5" />
            New entry
          </Button>
        </div>
        <DayPlanList day={day} plans={plans} />
      </section>

      <DayRecord day={day} filters={filters} className="mt-8" />
    </SidePeek>
  );
}
