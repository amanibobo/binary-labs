"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
  eventHref,
  FILE_KINDS_ON_RECORD,
  groupKey,
  recordLine,
  type CalendarEntry,
  type CalendarFilters,
  type DayEvent,
  type RecordGroup,
} from "@/lib/calendar";
import { plansOn, whenLine } from "@/lib/calendar-edit";
import { formatCalendarDay, formatTime, type CalendarDay } from "@/lib/calendar-time";
import type { FileHit } from "@/lib/domain";
import { authorName } from "@/lib/protocols";
import { PlusIcon } from "../icons/base-web";
import { FileResult } from "../search/file-result";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { useCalendarApi } from "./calendar-api";
import { KindDot, useCalendar } from "./calendar-context";
import { SidePeek } from "./side-peek";

// A day opened: its plans, then its record, each item opening the way it does elsewhere: files
// as search rows with their preview, protocols, charts and talk-throughs on their own pages.
export function DayPeek({
  day,
  filters,
  plans,
  onClose,
  onNewEntry,
}: {
  day: CalendarDay;
  filters: CalendarFilters;
  plans: readonly CalendarEntry[];
  onClose: () => void;
  onNewEntry: () => void;
}) {
  const api = useCalendarApi();
  const { timeZone, actions } = useCalendar();
  const headingId = useId();
  const [expanded, setExpanded] = useState<string | null>(null);
  const record = useQuery({
    queryKey: ["calendar", "day", day, timeZone, filters],
    queryFn: ({ signal }) => api.day({ day, timeZone, filters }, signal),
  });
  const dayPlans = plansOn(day, plans, timeZone);

  return (
    <SidePeek labelledBy={headingId} onClose={onClose}>
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
        {dayPlans.length === 0 ? (
          <p className="mt-1 text-paragraph-small text-content-tertiary">Nothing planned.</p>
        ) : (
          <ul className="mt-2 grid gap-1">
            {dayPlans.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => actions.openEntry(entry.id)}
                  className="flex w-full min-w-0 items-baseline gap-3 rounded-lg px-3 py-2 text-left hover:bg-background-secondary"
                >
                  <span className="w-28 shrink-0 text-paragraph-small text-content-tertiary">{whenLine(entry.when, timeZone)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-label-medium text-content-primary">{entry.title}</span>
                    {entry.instrument !== null || entry.protocol !== null ? (
                      <span className="block truncate text-paragraph-xsmall text-content-tertiary">
                        {[entry.instrument?.name, entry.protocol?.title].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="On the record" className="mt-8">
        <h3 className="text-label-medium text-content-secondary">On the record</h3>
        {record.isPending ? (
          <div className="mt-3 grid gap-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : record.isError ? (
          <p className="mt-1 text-paragraph-small text-content-negative">We couldn&apos;t load this day. Close it and try again.</p>
        ) : record.data.record.length === 0 ? (
          <p className="mt-1 text-paragraph-small text-content-tertiary">Nothing was added this day.</p>
        ) : (
          <div className="mt-3 grid gap-6">
            {record.data.record.map((group) => (
              <div key={groupKey(group)}>
                <p className="flex items-center gap-2 text-paragraph-small text-content-primary">
                  <KindDot kind={group.kind} className="size-2" />
                  {recordLine(group)}
                </p>
                {FILE_KINDS_ON_RECORD.has(group.kind) ? (
                  <GroupFiles
                    group={group}
                    filters={filters}
                    first={record.data.files.find((f) => f.kind === group.kind && f.groupId === group.groupId)?.hits ?? []}
                    expanded={expanded}
                    onToggle={(sha) => setExpanded((cur) => (cur === sha ? null : sha))}
                  />
                ) : (
                  <GroupEvents events={record.data.events.filter((e) => belongs(e, group))} />
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </SidePeek>
  );
}

function belongs(event: DayEvent, group: RecordGroup): boolean {
  return event.kind === group.kind && (event.kind !== "protocol" || event.id === group.groupId);
}

function GroupFiles({
  group,
  filters,
  first,
  expanded,
  onToggle,
}: {
  group: RecordGroup;
  filters: CalendarFilters;
  first: FileHit[];
  expanded: string | null;
  onToggle: (sha: string) => void;
}) {
  const api = useCalendarApi();
  const { timeZone } = useCalendar();
  const [more, setMore] = useState<FileHit[]>([]);
  const [loading, setLoading] = useState(false);
  const shown = [...first, ...more];
  const left = group.items - shown.length;

  async function loadMore() {
    setLoading(true);
    try {
      const next = await api.dayFiles(
        { day: group.day, timeZone, filters, kind: group.kind, groupId: group.groupId, offset: shown.length },
        new AbortController().signal,
      );
      setMore((prev) => [...prev, ...next]);
    } catch {
      toast.error("We couldn't load more files. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <ul className="-mx-3 mt-1">
        {shown.map((hit) => (
          <FileResult key={hit.sha256} hit={hit} query="" expanded={expanded === hit.sha256} onToggle={() => onToggle(hit.sha256)} />
        ))}
      </ul>
      {left > 0 ? (
        <Button variant="tertiary" size="compact" className="mt-1 -ml-3 text-content-secondary" disabled={loading} onClick={() => void loadMore()}>
          {loading ? "Loading…" : `Show ${Math.min(left, 50)} more of ${left}`}
        </Button>
      ) : null}
    </>
  );
}

function GroupEvents({ events }: { events: DayEvent[] }) {
  const { timeZone, lists } = useCalendar();
  return (
    <ul className="mt-1 grid gap-0.5">
      {events.map((event) => (
        <li key={`${event.kind}:${event.id}:${event.at}`}>
          <Link href={eventHref(event)} className="flex min-w-0 items-baseline gap-3 rounded-lg px-3 py-2 -mx-3 hover:bg-background-secondary">
            <span className="min-w-0 flex-1 truncate text-label-medium text-content-primary">{event.title}</span>
            <span className="shrink-0 text-paragraph-xsmall text-content-tertiary">
              {formatTime(new Date(event.at), timeZone)} · {authorName(lists.authors, event.actor)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
