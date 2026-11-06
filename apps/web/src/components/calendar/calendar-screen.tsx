"use client";

import type { CalendarStart } from "@/lib/calendar-start";
import { LabelsProvider, LabListsProvider } from "../labels/labels-context";
import type { CalendarLists } from "./calendar-context";
import { CalendarView } from "./calendar-view";

// The page's client half: a day's files are search rows, whose labels edit in place.
export function CalendarScreen({
  start,
  lists,
  viewer,
  timeZone,
  now,
}: {
  start: CalendarStart;
  lists: CalendarLists;
  viewer: string;
  timeZone?: string;
  now?: string;
}) {
  return (
    <LabListsProvider value={{ experiments: [...lists.experiments], people: [...lists.people] }}>
      <LabelsProvider>
        <CalendarView start={start} lists={lists} viewer={viewer} timeZone={timeZone} now={now} />
      </LabelsProvider>
    </LabListsProvider>
  );
}
