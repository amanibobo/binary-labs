"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { draftOf, type CalendarEntry, type CalendarEntryId, type CalendarFilters, type EntryWhen } from "@/lib/calendar";
import { allDayOn, shiftWhen, stretchWhen, whenLine } from "@/lib/calendar-edit";
import { jumpToMonth, stepAnchor, startOfYear, viewRange, yearOf } from "@/lib/calendar-nav";
import type { ChangeScope } from "@/lib/calendar-repeat";
import {
  calendarSearch,
  calendarStart,
  isNewHistoryEntry,
  resolveStart,
  storedMode,
  viewStorageKey,
  type CalendarMode,
  type CalendarOpen,
  type CalendarPlace,
  type CalendarStart,
} from "@/lib/calendar-start";
import {
  addDays,
  addMonths,
  CalendarDay,
  daysBetween,
  formatCalendarDay,
  inRange,
  snap,
  startOfMonth,
  todayIn,
  viewerTimeZone,
  wallClock,
  weekOf,
} from "@/lib/calendar-time";
import { cn } from "@/lib/cn";
import { CheckIcon, ChevronDownIcon } from "../icons/base-web";
import { buttonVariants } from "../ui/button";
import { menuItem, menuSurface } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { useCalendarApi } from "./calendar-api";
import { CalendarProvider, ENTRY_KEYS_HELP, ENTRY_KEYS_ID, type CalendarActions, type CalendarLists, type DragMode } from "./calendar-context";
import { CalendarHeader } from "./calendar-header";
import { Agenda } from "./agenda";
import { DayPeek } from "./day-peek";
import { FeedButton } from "./feed-dialog";
import { recordGroupAnchor } from "./day-record";
import { DAY_RECORD_ID, DayView, PhoneDay } from "./day-view";
import { EntryPeek } from "./entry-peek";
import type { PendingEntry } from "./inline-title";
import { MonthView } from "./month-view";
import { ScopeQuestion, type ScopeAsk } from "./scope-question";
import { useEntryWrites, type AskScope } from "./use-entry-writes";
import { HOUR_PX, WeekView } from "./week-view";
import { YearView } from "./year-view";

const noSubscribe = () => () => {};
const WIDE = "(min-width: 768px)";
const VIEW_KEYS: Record<string, CalendarMode> = { d: "day", w: "week", m: "month", y: "year" };

// The server can't know the viewer's zone, so the calendar draws once the browser can say.
// Fixture pages pin the zone and the clock so screenshots hold still.
export function CalendarView({
  start,
  lists,
  viewer,
  timeZone: pinnedZone,
  now: pinnedNow,
}: {
  start: CalendarStart;
  lists: CalendarLists;
  // Whose last view to remember in this browser.
  viewer: string;
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
  return <CalendarBody start={start} lists={lists} viewer={viewer} timeZone={zone} pinnedNow={now} today={todayIn(zone, now ?? new Date())} />;
}

function readStoredMode(viewer: string): CalendarMode | null {
  try {
    return storedMode(window.localStorage.getItem(viewStorageKey(viewer)));
  } catch {
    return null;
  }
}

function writeStoredMode(viewer: string, mode: CalendarMode) {
  try {
    window.localStorage.setItem(viewStorageKey(viewer), mode);
  } catch {
    // Private windows and blocked storage just don't remember.
  }
}

type Drag = { id: CalendarEntryId; when: EntryWhen };

function CalendarBody({
  start,
  lists,
  viewer,
  timeZone,
  today,
  pinnedNow,
}: {
  start: CalendarStart;
  lists: CalendarLists;
  viewer: string;
  timeZone: string;
  today: CalendarDay;
  pinnedNow: Date | null;
}) {
  const api = useCalendarApi();
  // This only renders in the browser, so the first place can read the screen and storage.
  const [initial] = useState<CalendarPlace>(() =>
    resolveStart(start, { stored: readStoredMode(viewer), phone: !window.matchMedia(WIDE).matches, today }),
  );
  const [mode, setMode] = useState<CalendarMode>(initial.mode);
  const [anchor, setAnchor] = useState<CalendarDay>(initial.anchor);
  const [open, setOpen] = useState<CalendarOpen>(initial.open);
  const [filters, setFilters] = useState<CalendarFilters>({});
  const [pending, setPending] = useState<PendingEntry | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [said, setSaid] = useState("");
  const [scopeAsk, setScopeAsk] = useState<ScopeAsk | null>(null);
  // The last answer to "only this one or all?", reused while the same entry keeps changing
  // from the side peek or the arrow keys. A drag always asks.
  const remembered = useRef<{ id: CalendarEntryId; scope: ChangeScope } | null>(null);
  const askScope: AskScope = (entry, how) => {
    const known = remembered.current;
    if (how.ask === "once" && known?.id === entry.id) return Promise.resolve(known.scope);
    const before = document.activeElement;
    return new Promise((resolve) =>
      setScopeAsk({
        entry,
        answer: (scope) => {
          setScopeAsk(null);
          remembered.current = scope === null ? null : { id: entry.id, scope };
          resolve(scope);
          // A move redraws the entry in another day, so what had focus may be gone; go back
          // to it, or to the entry, once the answer has landed on screen.
          setTimeout(
            () =>
              requestAnimationFrame(() => {
                const back = before instanceof HTMLElement && before.isConnected && before !== document.body ? before : null;
                (back ?? document.querySelector<HTMLElement>(`[data-entry="${entry.id}"]`))?.focus();
              }),
            0,
          );
        },
      }),
    );
  };
  const writes = useEntryWrites({ timeZone, askScope });
  const justDragged = useRef(false);
  const shownPlace = useRef<CalendarPlace | null>(null);

  const range = viewRange(mode, anchor);
  const year = yearOf(anchor);
  const data = useQuery({
    queryKey: ["calendar", "range", range.first, range.last, timeZone, filters],
    queryFn: ({ signal }) => api.range({ range, timeZone, filters }, signal),
    placeholderData: keepPreviousData,
    enabled: mode !== "year",
  });
  const yearData = useQuery({
    queryKey: ["calendar", "year", year, timeZone, filters],
    queryFn: ({ signal }) => api.year({ year, timeZone, filters }, signal),
    placeholderData: keepPreviousData,
    enabled: mode === "year",
  });
  const plans = (data.data?.plans ?? []).map((p) => (drag !== null && p.id === drag.id ? { ...p, when: drag.when } : p));
  const record = data.data?.record ?? [];

  // The address follows what's on screen, so a reload or a shared link opens the same thing.
  // A new view or date is a step Back can retrace; the side peek only rewrites the step.
  useEffect(() => {
    const place: CalendarPlace = { mode, anchor, open };
    const url = new URL(window.location.href);
    url.search = calendarSearch(place, url.searchParams);
    const before = shownPlace.current;
    if (before !== null && isNewHistoryEntry(before, place)) window.history.pushState(null, "", url);
    else window.history.replaceState(window.history.state, "", url);
    shownPlace.current = place;
  }, [mode, anchor, open]);

  useEffect(() => {
    const onPop = () => {
      const place = resolveStart(calendarStart(Object.fromEntries(new URLSearchParams(window.location.search))), {
        stored: mode,
        phone: false,
        today,
      });
      shownPlace.current = place;
      setPending(null);
      setMode(place.mode);
      setAnchor(place.anchor);
      setOpen(place.open);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });

  useEffect(() => writeStoredMode(viewer, mode), [viewer, mode]);

  useEffect(() => {
    remembered.current = null;
  }, [open]);

  const go = (next: { mode?: CalendarMode; anchor?: CalendarDay }) => {
    setPending(null);
    if (next.mode !== undefined) setMode(next.mode);
    if (next.anchor !== undefined) setAnchor(next.anchor);
  };
  const step = (n: number) => go({ anchor: stepAnchor(mode, anchor, n) });
  const showDay = (day: CalendarDay) => {
    setOpen({ kind: "none" });
    go({ mode: "day", anchor: day });
  };

  function focusEntry(id: CalendarEntryId) {
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-entry="${id}"]`)?.focus());
  }

  function moveBy(entry: CalendarEntry, dragMode: DragMode, by: { days: number; minutes: number }) {
    const when = dragMode === "move" ? shiftWhen(entry.when, by, timeZone) : stretchWhen(entry.when, by, timeZone);
    void writes.save(entry, { ...draftOf(entry), when }, { ask: "once" });
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
    openDay: (day, group) => {
      if (mode !== "day") {
        setOpen({ kind: "day", day });
        return;
      }
      // The day view has the record beside it already.
      if (day !== anchor) {
        go({ anchor: day });
        return;
      }
      const target = document.getElementById(group === undefined ? DAY_RECORD_ID : recordGroupAnchor(day, group));
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      target?.focus({ preventScroll: true });
    },
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

  // Dragging: the entry follows the pointer to the day (and on the hours, the quarter hour)
  // under it, and saves where it's let go. A press that doesn't move is a click.
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
      // Drawn where it was let go until it's saved, or back where it was if the person backs out.
      void writes.save(entry, { ...draftOf(entry), when: last }, { ask: "always" }).then(() => setDrag(null));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  // The keyboard's way to drag: Alt and an arrow moves an entry, Shift too changes its end.
  function entryKeys(entry: CalendarEntry, event: KeyboardEvent<HTMLElement>) {
    if (!event.altKey) return;
    const onHours = (mode === "week" || mode === "day") && entry.when.kind === "timed";
    const by = {
      ArrowLeft: { days: -1, minutes: 0 },
      ArrowRight: { days: 1, minutes: 0 },
      ArrowUp: onHours ? { days: 0, minutes: -15 } : { days: -7, minutes: 0 },
      ArrowDown: onHours ? { days: 0, minutes: 15 } : { days: 7, minutes: 0 },
    }[event.key];
    if (by === undefined) return;
    event.preventDefault();
    moveBy(entry, event.shiftKey ? "resize" : "move", by);
  }

  // T for today; D, W, M and Y for the views; the arrow keys for the next and last one.
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
      const view = VIEW_KEYS[key];
      if (key === "t") go({ anchor: today });
      else if (view !== undefined) go({ mode: view });
      else if (key === "arrowleft" && target === document.body) step(-1);
      else if (key === "arrowright" && target === document.body) step(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const openEntry = open.kind === "entry" ? (data.data?.plans.find((p) => p.id === open.id) ?? null) : null;
  const newWhen = allDayOn(inRange(today, range) ? today : mode === "month" ? startOfMonth(anchor) : range.first);
  const onHours = mode === "week" || mode === "day";
  const failed = <p className="py-10 text-paragraph-medium text-content-tertiary">We couldn&apos;t load the calendar. Reload the page to try again.</p>;

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
      <div className={cn("flex flex-col", onHours && "md:h-dvh")}>
        <CalendarHeader
          mode={mode}
          anchor={anchor}
          today={today}
          onMode={(m) => go({ mode: m })}
          onStep={step}
          onToday={() => go({ anchor: today })}
          onPick={(to) => go(jumpToMonth({ mode, anchor }, to))}
          onYear={(y) => go({ anchor: startOfYear(y) })}
          onNew={() => setOpen({ kind: "new", when: newWhen })}
        />
        <Filters lists={lists} value={filters} onChange={setFilters} end={<FeedButton />} />

        {mode === "year" ? (
          <div className="px-4 pt-2 pb-24 sm:px-8 md:pb-10">
            {yearData.isPending ? (
              <Skeleton className="h-[600px] w-full" />
            ) : yearData.isError ? (
              failed
            ) : (
              <YearView year={year} activity={yearData.data} onMonth={(first) => go({ mode: "month", anchor: first })} onDay={showDay} />
            )}
          </div>
        ) : (
          <>
            <div className={cn("hidden px-4 pb-10 sm:px-8 md:block", onHours && "md:flex md:min-h-0 md:flex-1 md:flex-col md:pb-0")}>
              {data.isPending ? (
                <Skeleton className="h-[600px] w-full" />
              ) : data.isError ? (
                failed
              ) : mode === "month" ? (
                <MonthView anchor={anchor} plans={plans} record={record} pending={pending} />
              ) : mode === "week" ? (
                <WeekView anchor={anchor} plans={plans} record={record} pending={pending} />
              ) : (
                <DayView day={anchor} plans={plans} record={record} pending={pending} filters={filters} />
              )}
            </div>
            <div className="pb-24 md:hidden">
              {data.isPending ? (
                <div className="grid gap-3 px-4 pt-4">
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                </div>
              ) : mode === "day" ? (
                <PhoneDay day={anchor} plans={plans} filters={filters} />
              ) : (
                <Agenda days={mode === "month" ? monthDays(anchor) : weekOf(anchor)} plans={plans} record={record} />
              )}
            </div>
          </>
        )}
      </div>

      <p aria-live="polite" className="sr-only">
        {said}
      </p>
      <p id={ENTRY_KEYS_ID} hidden>
        {ENTRY_KEYS_HELP}
      </p>
      <ScopeQuestion ask={scopeAsk} />

      {open.kind === "day" ? (
        <DayPeek
          key={open.day}
          day={open.day}
          filters={filters}
          plans={plans}
          onClose={() => setOpen({ kind: "none" })}
          onNewEntry={() => setOpen({ kind: "new", when: allDayOn(open.day) })}
          onDayView={() => showDay(open.day)}
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

// The day and, on the hours, the quarter hour under a point.
function slotAt(x: number, y: number): { day: CalendarDay; minutes: number | null } | null {
  const cell = document.elementsFromPoint(x, y).find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.day !== undefined);
  if (cell === undefined) return null;
  const day = CalendarDay.safeParse(cell.dataset.day);
  if (!day.success) return null;
  if (cell.dataset.timegrid === undefined) return { day: day.data, minutes: null };
  return { day: day.data, minutes: snap(((y - cell.getBoundingClientRect().top) / HOUR_PX) * 60) };
}

function Filters({
  lists,
  value,
  onChange,
  end,
}: {
  lists: CalendarLists;
  value: CalendarFilters;
  onChange: (next: CalendarFilters) => void;
  end: ReactNode;
}) {
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
      <div className="ml-auto pl-2">{end}</div>
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
