"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { calendarHref } from "@/lib/calendar";
import { whenLine } from "@/lib/calendar-edit";
import { startsLine } from "@/lib/calendar-repeat";
import { daysBetween, todayIn, viewerTimeZone, wallClock } from "@/lib/calendar-time";
import { httpCalendarApi, useCalendarApi } from "./calendar-api";

const noSubscribe = () => () => {};
const EVERY_MINUTE = 60_000;

// Calendar reminders, wherever in Binary you are: a note that stays until it's closed, once per
// reminder on any device. Asked for every minute while the tab is in view.
export function ReminderToasts() {
  const api = useCalendarApi();
  const router = useRouter();
  const timeZone = useSyncExternalStore(noSubscribe, viewerTimeZone, () => null);
  const shown = useRef(new Set<string>());
  // Fixture pages without the calendar's canned data have no server to ask.
  const live = timeZone !== null && (api !== httpCalendarApi || !window.location.pathname.startsWith("/dev/"));
  const due = useQuery({
    queryKey: ["calendar", "reminders", timeZone],
    queryFn: ({ signal }) => api.dueReminders(timeZone ?? "UTC", signal),
    enabled: live,
    refetchInterval: EVERY_MINUTE,
    retry: false,
  });

  useEffect(() => {
    if (timeZone === null) return;
    for (const { entry, minutes, at } of due.data ?? []) {
      const key = `${entry.id}:${minutes}:${at}`;
      if (shown.current.has(key)) continue;
      shown.current.add(key);
      const day = entry.when.kind === "allDay" ? entry.when.first : wallClock(new Date(entry.when.start), timeZone).day;
      const soon = entry.when.kind === "allDay" ? dayWord(daysBetween(todayIn(timeZone), day)) : startsLine(Date.parse(entry.when.start), Date.now());
      toast(entry.title, {
        id: key,
        description: `${soon} · ${whenLine(entry.when, timeZone)}`,
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
        action: { label: "Open", onClick: () => router.push(calendarHref({ day, entry: entry.id })) },
      });
      void api.reminderShown({ entryId: entry.id, minutes, at });
    }
  }, [due.data, api, router, timeZone]);

  return null;
}

function dayWord(days: number): string {
  if (days <= 0) return "Today";
  return days === 1 ? "Tomorrow" : `In ${days} days`;
}
