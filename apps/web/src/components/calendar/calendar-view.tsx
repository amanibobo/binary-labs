"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { draftOf, type CalendarEntry, type CalendarEntryId, type CalendarFilters, type EntryWhen } from "@/lib/calendar";
import type { CalendarMode, CalendarOpen, CalendarStart } from "@/lib/calendar-start";
import { allDayOn, shiftWhen, stretchWhen, whenLine } from "@/lib/calendar-edit";
import {
  addDays,
  addMonths,
  CalendarDay,
  daysBetween,
  formatCalendarDay,
  formatWeekTitle,
  inRange,
  monthGrid,
  snap,
  startOfMonth,
  todayIn,
  viewerTimeZone,
  wallClock,
  weekOf,
  type DayRange,
} from "@/lib/calendar-time";
import { cn } from "@/lib/cn";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon } from "../icons/base-web";
import { Button, buttonVariants } from "../ui/button";
import { menuItem, menuSurface } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { useCalendarApi } from "./calendar-api";
import { CalendarProvider, ENTRY_KEYS_HELP, ENTRY_KEYS_ID, type CalendarActions, type CalendarLists, type DragMode } from "./calendar-context";
import { Agenda } from "./agenda";
import { DayPeek } from "./day-peek";
import { EntryPeek } from "./entry-peek";
import type { PendingEntry } from "./inline-title";
import { MonthView } from "./month-view";
import { useEntryWrites } from "./use-entry-writes";
import { HOUR_PX, WeekView } from "./week-view";

const noSubscribe = () => () => {};

// The server can't know the viewer's zone, so the calendar draws once the browser can say.
// Fixture pages pin the zone and the clock so screenshots hold still.
export function CalendarView({
  start,
  lists,
  timeZone: pinnedZone,
  now: pinnedNow,
}: {
  start: CalendarStart;
  lists: CalendarLists;
  timeZone?: string;
  now?: string;
}) {
  const zone = useSyncExternalStore(
    noSubscribe,
    () => pinnedZone ?? viewerTimeZone(),
    () => null,
  );
  if (zone === null) {
    return (
      <div className="px-4 pt-8 sm:px-8">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="mt-8 h-[560px] w-full" />
      </div>
    );
  }
  const now = pinnedNow === undefined ? null : new Date(pinnedNow);
  return <CalendarBody start={start} lists={lists} timeZone={zone} pinnedNow={now} today={todayIn(zone, now ?? new Date())} />;
}

function rangeOf(mode: CalendarMode, anchor: CalendarDay): DayRange {
  const days = mode === "month" ? monthGrid(anchor).flat() : weekOf(anchor);
  const first = days[0] ?? anchor;
  return { first, last: days.at(-1) ?? first };
}

type Drag = { id: CalendarEntryId; when: EntryWhen };

function CalendarBody({
  start,
  lists,
  timeZone,
  today,
  pinnedNow,
}: {
  start: CalendarStart;
  lists: CalendarLists;
  timeZone: string;
  today: CalendarDay;
  pinnedNow: Date | null;
}) {
  const api = useCalendarApi();
  const writes = useEntryWrites();
  const [mode, setMode] = useState<CalendarMode>(start.mode);
  const [anchor, setAnchor] = useState<CalendarDay>(start.date ?? today);
  const [filters, setFilters] = useState<CalendarFilters>({});
  const [open, setOpen] = useState<CalendarOpen>(start.open);
  const [pending, setPending] = useState<PendingEntry | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [said, setSaid] = useState("");
  const justDragged = useRef(false);

  const range = rangeOf(mode, anchor);
  const data = useQuery({
    queryKey: ["calendar", "range", range.first, range.last, timeZone, filters],
    queryFn: ({ signal }) => api.range({ range, timeZone, filters }, signal),
    placeholderData: keepPreviousData,
  });
  const plans = (data.data?.plans ?? []).map((p) => (drag !== null && p.id === drag.id ? { ...p, when: drag.when } : p));
  const record = data.data?.record ?? [];

  // The address follows what's on screen, so a reload or a shared link opens the same thing.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", mode);
    url.searchParams.set("date", anchor);
    url.searchParams.delete("day");
    url.searchParams.delete("entry");
    if (open.kind === "day") url.searchParams.set("day", open.day);
    if (open.kind === "entry") url.searchParams.set("entry", open.id);
    window.history.replaceState(null, "", url);
  }, [mode, anchor, open]);

  const step = (n: number) => setAnchor((a) => (mode === "month" ? addMonths(a, n) : addDays(a, 7 * n)));

  function focusEntry(id: CalendarEntryId) {
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-entry="${id}"]`)?.focus());
  }

  function moveBy(entry: CalendarEntry, mode: DragMode, by: { days: number; minutes: number }) {
    const when = mode === "move" ? shiftWhen(entry.when, by, timeZone) : stretchWhen(entry.when, by, timeZone);
    void writes.save(entry, { ...draftOf(entry), when });
    const day = when.kind === "allDay" ? when.first : wallClock(new Date(when.start), timeZone).day;
    setSaid(`${entry.title}: ${formatCalendarDay(day, "medium")}, ${whenLine(when, timeZone)}`);
    focusEntry(entry.id);
  }

  const actions: CalendarActions = {
    openEntry: (id) => {
      if (justDragged.current) return;
      setPending(null);
      setOpen({ kind: "entry", id });
    },
    openDay: (day) => setOpen({ kind: "day", day }),
    beginCreate: (when) => {
      if (justDragged.current) return;
      setPending({ when });
    },
    finishCreate: (title) => {
      const when = pending?.when;
      setPending(null);
      if (title === null || when === undefined) return;
      void writes.create({ title, notes: null, when, experimentId: null, protocolId: null, instrumentId: null, personIds: [] });
    },
    startDrag: (entry, dragMode, event) => startDrag(entry, dragMode, event),
    entryKeys: (entry, event) => entryKeys(entry, event),
  };

  // Dragging: the entry follows the pointer to the day (and on the week's grid, the quarter
  // hour) under it, and saves where it's let go. A press that doesn't move is a click.
  function startDrag(entry: CalendarEntry, dragMode: DragMode, event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || event.pointerType === "touch") return;
    event.stopPropagation();
    const origin = slotAt(event.clientX, event.clientY);
    if (origin === null) return;
    const x0 = event.clientX;
    const y0 = event.clientY;
    let moved = false;
    let last: EntryWhen = entry.when;
    const onMove = (e: globalThis.PointerEvent) => {
      if (!moved && Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
      moved = true;
      const at = slotAt(e.clientX, e.clientY);
      if (at === null) return;
      const by = {
        days: daysBetween(origin.day, at.day),
        minutes: origin.minutes !== null && at.minutes !== null && entry.when.kind === "timed" ? at.minutes - origin.minutes : 0,
      };
      last = dragMode === "move" ? shiftWhen(entry.when, by, timeZone) : stretchWhen(entry.when, by, timeZone);
      setDrag({ id: entry.id, when: last });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!moved) return;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      void writes.save(entry, { ...draftOf(entry), when: last });
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // The keyboard's way to drag: Alt and an arrow moves an entry, Shift too changes its end.
  function entryKeys(entry: CalendarEntry, event: KeyboardEvent<HTMLElement>) {
    if (!event.altKey) return;
    const timedGrid = mode === "week" && entry.when.kind === "timed";
    const by = {
      ArrowLeft: { days: -1, minutes: 0 },
      ArrowRight: { days: 1, minutes: 0 },
      ArrowUp: timedGrid ? { days: 0, minutes: -15 } : { days: -7, minutes: 0 },
      ArrowDown: timedGrid ? { days: 0, minutes: 15 } : { days: 7, minutes: 0 },
    }[event.key];
    if (by === undefined) return;
    event.preventDefault();
    moveBy(entry, event.shiftKey ? "resize" : "move", by);
  }

  // T for today, M and W for the views, the arrow keys for the next and last month or week.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.closest("input, textarea, select, [role=dialog], [role=menu]") !== null || target.isContentEditable)
      )
        return;
      const key = e.key.toLowerCase();
      if (key === "t") setAnchor(today);
      else if (key === "m") setMode("month");
      else if (key === "w") setMode("week");
      else if (key === "arrowleft" && target === document.body) step(-1);
      else if (key === "arrowright" && target === document.body) step(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const openEntry = open.kind === "entry" ? (data.data?.plans.find((p) => p.id === open.id) ?? null) : null;
  const title = mode === "month" ? formatCalendarDay(anchor, "month") : formatWeekTitle(range.first, range.last);
  const newWhen = allDayOn(inRange(today, range) ? today : mode === "month" ? startOfMonth(anchor) : range.first);

  return (
    <CalendarProvider
      value={{
        timeZone,
        today,
        lists,
        actions,
        selected: open.kind === "entry" ? open.id : null,
        dragging: drag?.id ?? null,
        shownDay: open.kind === "day" ? open.day : null,
        pinnedNow,
      }}
    >
      <div className={cn("flex flex-col", mode === "week" && "md:h-dvh")}>
        <header className="flex flex-wrap items-center gap-x-1 gap-y-3 px-4 pt-5 pb-3 sm:gap-x-2 sm:px-8 sm:pt-8">
          <h1 className="mr-auto min-w-0 text-heading-xsmall sm:text-heading-medium" aria-live="polite">
            {title}
          </h1>
          <div
            role="group"
            aria-label="View"
            className="hidden rounded-control bg-background-secondary p-0.5 ring-1 ring-border-opaque ring-inset md:flex"
          >
            {(["month", "week"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                aria-keyshortcuts={m === "month" ? "M" : "W"}
                onClick={() => setMode(m)}
                className={cn(
                  "min-h-7 rounded-[8px] px-3 text-label-small transition-colors duration-150",
                  mode === m ? "bg-background-raised text-content-primary shadow-raised" : "text-content-secondary hover:text-content-primary",
                )}
              >
                {m === "month" ? "Month" : "Week"}
              </button>
            ))}
          </div>
          <div className="flex items-center">
            <Button variant="tertiary" size="compact" shape="square" onClick={() => step(-1)}>
              <ChevronRightIcon className="size-5 rotate-180" />
              <span className="sr-only">{mode === "month" ? "Previous month" : "Previous week"}</span>
            </Button>
            <Button variant="tertiary" size="compact" aria-keyshortcuts="T" onClick={() => setAnchor(today)}>
              Today
            </Button>
            <Button variant="tertiary" size="compact" shape="square" onClick={() => step(1)}>
              <ChevronRightIcon className="size-5" />
              <span className="sr-only">{mode === "month" ? "Next month" : "Next week"}</span>
            </Button>
          </div>
          <Button size="compact" className="max-sm:w-11 max-sm:px-0" onClick={() => setOpen({ kind: "new", when: newWhen })}>
            <PlusIcon className="size-5" />
            <span className="max-sm:sr-only">New entry</span>
          </Button>
        </header>
        <Filters lists={lists} value={filters} onChange={setFilters} />

        <div className={cn("hidden px-4 pb-10 sm:px-8 md:block", mode === "week" && "md:flex md:min-h-0 md:flex-1 md:flex-col md:pb-0")}>
          {data.isPending ? (
            <Skeleton className="h-[600px] w-full" />
          ) : data.isError ? (
            <p className="py-10 text-paragraph-medium text-content-tertiary">We couldn&apos;t load the calendar. Reload the page to try again.</p>
          ) : mode === "month" ? (
            <MonthView anchor={anchor} plans={plans} record={record} pending={pending} />
          ) : (
            <WeekView anchor={anchor} plans={plans} record={record} pending={pending} />
          )}
        </div>
        <div className="pb-24 md:hidden">
          {data.isPending ? (
            <div className="grid gap-3 px-4 pt-4">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : (
            <Agenda days={mode === "month" ? monthDays(anchor) : weekOf(anchor)} plans={plans} record={record} />
          )}
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {said}
      </p>
      <p id={ENTRY_KEYS_ID} hidden>
        {ENTRY_KEYS_HELP}
      </p>

      {open.kind === "day" ? (
        <DayPeek
          key={open.day}
          day={open.day}
          filters={filters}
          plans={plans}
          onClose={() => setOpen({ kind: "none" })}
          onNewEntry={() => setOpen({ kind: "new", when: allDayOn(open.day) })}
        />
      ) : null}
      {open.kind === "entry" && openEntry !== null ? (
        <EntryPeek
          key={open.id}
          entry={openEntry}
          newWhen={openEntry.when}
          writes={writes}
          onClose={() => setOpen({ kind: "none" })}
          onCreated={() => undefined}
        />
      ) : null}
      {open.kind === "new" ? (
        <EntryPeek
          key="new"
          entry={null}
          newWhen={open.when}
          writes={writes}
          onClose={() => setOpen({ kind: "none" })}
          onCreated={(entry) => setOpen({ kind: "entry", id: entry.id })}
        />
      ) : null}
    </CalendarProvider>
  );
}

function monthDays(anchor: CalendarDay): CalendarDay[] {
  const first = startOfMonth(anchor);
  return Array.from({ length: daysBetween(first, addMonths(first, 1)) }, (_, i) => addDays(first, i));
}

// The day and, on the week's grid, the quarter hour under a point.
function slotAt(x: number, y: number): { day: CalendarDay; minutes: number | null } | null {
  const cell = document.elementsFromPoint(x, y).find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.day !== undefined);
  if (cell === undefined) return null;
  const day = CalendarDay.safeParse(cell.dataset.day);
  if (!day.success) return null;
  if (cell.dataset.timegrid === undefined) return { day: day.data, minutes: null };
  return { day: day.data, minutes: snap(((y - cell.getBoundingClientRect().top) / HOUR_PX) * 60) };
}

function Filters({ lists, value, onChange }: { lists: CalendarLists; value: CalendarFilters; onChange: (next: CalendarFilters) => void }) {
  return (
    <div
      role="group"
      aria-label="Filters"
      className="flex items-center gap-x-1 overflow-x-auto px-1.5 pb-3 whitespace-nowrap [scrollbar-width:none] sm:flex-wrap sm:px-5.5 sm:pb-4"
    >
      <FilterMenu
        any="Any experiment"
        value={value.experiment}
        options={lists.experiments.map((e) => ({ id: e.id, name: e.name }))}
        onChange={(experiment) => onChange({ ...value, experiment })}
      />
      <FilterMenu
        any="Anyone"
        value={value.person}
        options={lists.people.map((p) => ({ id: p.id, name: p.name }))}
        onChange={(person) => onChange({ ...value, person })}
      />
      <FilterMenu
        any="Any instrument"
        value={value.instrument}
        options={lists.instruments.map((i) => ({ id: i.id, name: i.name }))}
        onChange={(instrument) => onChange({ ...value, instrument })}
      />
    </div>
  );
}

function FilterMenu<T extends string>({
  any,
  value,
  options,
  onChange,
}: {
  any: string;
  value: T | undefined;
  options: { id: T; name: string }[];
  onChange: (next: T | undefined) => void;
}) {
  const current = options.find((o) => o.id === value);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={cn(
          buttonVariants({ variant: "tertiary", size: "compact" }),
          "max-w-64 gap-1 pr-1.5 pl-2.5",
          current === undefined ? "text-content-secondary hover:text-content-primary" : "text-content-primary",
        )}
      >
        <span className="truncate">{current?.name ?? any}</span>
        <ChevronDownIcon className="size-5 shrink-0 text-content-tertiary" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className={cn(menuSurface, "max-h-80 overflow-y-auto")}>
          <DropdownMenu.RadioGroup value={value ?? ""} onValueChange={(next) => onChange(options.find((o) => o.id === next)?.id)}>
            {[{ id: "", name: any }, ...options].map((o) => (
              <DropdownMenu.RadioItem key={o.id} value={o.id} className={menuItem}>
                <MenuText>{o.name}</MenuText>
                <DropdownMenu.ItemIndicator>
                  <CheckIcon className="size-5" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuText({ children }: { children: ReactNode }) {
  return <span className="flex-1 truncate">{children}</span>;
}
