"use client";

import Link from "next/link";
import { useId, useSyncExternalStore } from "react";
import { calendarHref, entryDays, type CalendarEntry } from "@/lib/calendar";
import { whenLine } from "@/lib/calendar-edit";
import { daysBetween, formatCalendarDay, todayIn, viewerTimeZone } from "@/lib/calendar-time";

const noSubscribe = () => () => {};

// "On the calendar" on a protocol's page: the coming entries that use it, each opening on the
// calendar. The server sends a day's slack either side; the browser keeps what hasn't ended
// where the reader is.
export function ProtocolPlans({ entries, more }: { entries: readonly CalendarEntry[]; more: boolean }) {
  const headingId = useId();
  const timeZone = useSyncExternalStore(noSubscribe, viewerTimeZone, () => "UTC");
  const today = todayIn(timeZone);
  const coming = entries.filter((e) => daysBetween(today, entryDays(e.when, timeZone).last) >= 0);
  if (coming.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="mt-14">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 id={headingId} className="text-heading-xsmall">
          On the calendar
        </h2>
        <Link href="/calendar" className="text-paragraph-small text-content-accent underline-offset-2 hover:underline">
          Open the calendar
        </Link>
      </div>
      <ul className="grid gap-1">
        {coming.map((entry) => {
          const { first } = entryDays(entry.when, timeZone);
          return (
            <li key={entry.id}>
              <Link
                href={calendarHref({ day: first, entry: entry.id })}
                className="-mx-3 flex min-w-0 items-baseline gap-4 rounded-lg px-3 py-2.5 hover:bg-background-secondary"
              >
                <span className="w-28 shrink-0 text-paragraph-small text-content-secondary tabular-nums">{formatCalendarDay(first, "medium")}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label-medium text-content-primary">{entry.title}</span>
                  <span className="block truncate text-paragraph-xsmall text-content-tertiary">
                    {[whenLine(entry.when, timeZone), entry.instrument?.name, entry.people.map((p) => p.name).join(", ")].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {more ? <p className="mt-2 text-paragraph-small text-content-tertiary">More are on the calendar.</p> : null}
    </section>
  );
}
