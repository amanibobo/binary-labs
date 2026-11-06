"use client";

import type { CalendarStart } from "@/lib/calendar-start";
import type { CalendarDay } from "@/lib/calendar-time";
import { LabelsProvider, LabListsProvider } from "../labels/labels-context";
import type { CalendarLists } from "./calendar-context";
import { CalendarView } from "./calendar-view";

// The page's client half: a day's files are search rows, whose labels edit in place.
export function CalendarScreen({ start, lists, timeZone, today }: { start: CalendarStart; lists: CalendarLists; timeZone?: string; today?: CalendarDay }) {
  return (
    <LabListsProvider value={{ experiments: [...lists.experiments], people: [...lists.people] }}>
      <LabelsProvider>
        <CalendarView start={start} lists={lists} timeZone={timeZone} today={today} />
      </LabelsProvider>
    </LabListsProvider>
  );
}
