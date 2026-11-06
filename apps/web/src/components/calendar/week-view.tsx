"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { recordLine, type CalendarEntry, type RecordGroup } from "@/lib/calendar";
import { whenLine } from "@/lib/calendar-edit";
import { layoutDay, layoutSpans, segmentOn, visibleEnd } from "@/lib/calendar-layout";
import {
  dayNumber,
  formatCalendarDay,
  formatHour,
  instantAt,
  MINUTES_PER_DAY,
  snap,
  wallClock,
  weekOf,
  zoneName,
  type CalendarDay,
} from "@/lib/calendar-time";
import { cn } from "@/lib/cn";
import { ENTRY_KEYS_ID, KindDot, useCalendar } from "./calendar-context";
import { InlineTitle, type PendingEntry } from "./inline-title";

// Notion Calendar's week: the hours down the side, an all-day row on top with the day's record
// under it, and timed entries as blocks that share the width when they overlap.
export const HOUR_PX = 48;
const LINE = 22;
const RECORD_LINES = 3;
const GUTTER = "grid-cols-[56px_repeat(7,minmax(0,1fr))]";

export function WeekView({
  anchor,
  plans,
  record,
  pending,
}: {
  anchor: CalendarDay;
  plans: readonly CalendarEntry[];
  record: readonly RecordGroup[];
  pending: PendingEntry | null;
}) {
  const { timeZone, today, actions } = useCalendar();
  const days = weekOf(anchor);
  const first = days[0] ?? anchor;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Open on the working day, as Notion Calendar does.
    if (scroller.current !== null) scroller.current.scrollTop = 7.5 * HOUR_PX;
  }, []);

  return (
    <div className="flex min-h-0 flex-col border-t border-border-opaque select-none">
      <div className={cn("grid border-b border-border-opaque", GUTTER)}>
        <div className="self-end px-2 pb-1.5 text-right text-paragraph-xsmall text-content-tertiary">
          {zoneName(timeZone, instantAt(first, 12 * 60, timeZone))}
        </div>
        {days.map((day) => {
          const isToday = day === today;
          return (
            <button
              key={day}
              type="button"
              onClick={() => actions.openDay(day)}
              aria-label={`${formatCalendarDay(day, "long")}${isToday ? ", today" : ""}`}
              aria-current={isToday ? "date" : undefined}
              className="flex items-center gap-1.5 border-l border-border-opaque px-2 py-2 text-left hover:bg-background-secondary"
            >
              <span className="text-paragraph-xsmall text-content-tertiary">{formatCalendarDay(day, "weekdayShort")}</span>
              <span
                className={cn(
                  "grid h-6 min-w-6 place-items-center rounded-full px-1 text-label-small tabular-nums",
                  isToday ? "bg-content-primary text-content-inverse-primary" : "text-content-primary",
                )}
              >
                {dayNumber(day)}
              </span>
            </button>
          );
        })}
      </div>
      <AllDayRow days={days} plans={plans} record={record} pending={pending} />
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className={cn("grid", GUTTER)} style={{ height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 23 }, (_, i) => (
              <span
                key={i}
                className="absolute right-2 -translate-y-1/2 text-paragraph-xsmall text-content-tertiary tabular-nums"
                style={{ top: (i + 1) * HOUR_PX }}
              >
                {formatHour((i + 1) * 60)}
              </span>
            ))}
          </div>
          {days.map((day) => (
            <TimeColumn key={day} day={day} plans={plans} pending={pending} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AllDayRow({
  days,
  plans,
  record,
  pending,
}: {
  days: CalendarDay[];
  plans: readonly CalendarEntry[];
  record: readonly RecordGroup[];
  pending: PendingEntry | null;
}) {
  const { actions, selected, dragging } = useCalendar();
  const first = days[0];
  if (first === undefined) return null;
  const allDay = plans.filter((p) => p.when.kind === "allDay");
  const byId = new Map<string, CalendarEntry>(allDay.map((p) => [p.id, p]));
  const placed = layoutSpans(
    allDay.flatMap((p) => (p.when.kind === "allDay" ? [{ id: p.id, first: p.when.first, last: p.when.last, order: 0 }] : [])),
    first,
  );
  const pendingColumn = pending?.when.kind === "allDay" ? days.indexOf(pending.when.first) : -1;
  const lanes = Math.max(
    placed.reduce((n, p) => Math.max(n, p.lane + 1), 0),
    pendingColumn >= 0 ? 1 : 0,
  );
  const recordByDay = days.map((day) => record.filter((g) => g.day === day));
  const recordRows = Math.min(RECORD_LINES, Math.max(0, ...recordByDay.map((r) => r.length)));
  const rows = Math.max(1, lanes + recordRows);

  return (
    <div className={cn("grid border-b border-border-opaque", GUTTER)}>
      <div className="px-2 pt-1.5 text-right text-paragraph-xsmall text-content-tertiary">All day</div>
      <div className="relative col-span-7 grid grid-cols-7" style={{ minHeight: rows * LINE + 8 }}>
        {days.map((day) => (
          <div key={day} data-day={day} className="relative border-l border-border-opaque">
            <button
              type="button"
              tabIndex={-1}
              aria-label={`New all-day entry on ${formatCalendarDay(day, "long")}`}
              onClick={() => actions.beginCreate({ kind: "allDay", first: day, last: day })}
              className="absolute inset-0 cursor-default"
            />
          </div>
        ))}
        <div className="pointer-events-none absolute inset-x-0 top-1 grid grid-cols-7" style={{ gridTemplateRows: `repeat(${rows}, ${LINE}px)` }}>
          {placed.map((p) => {
            const entry = byId.get(p.id);
            if (entry === undefined) return null;
            return (
              <div
                key={p.id}
                className={cn("pointer-events-auto relative min-w-0 py-px", p.startsBefore ? "pl-0" : "pl-1", p.endsAfter ? "pr-0" : "pr-1")}
                style={{ gridColumn: `${p.column + 1} / span ${p.length}`, gridRow: p.lane + 1 }}
              >
                <button
                  type="button"
                  data-entry={entry.id}
                  aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
                  aria-describedby={ENTRY_KEYS_ID}
                  onClick={() => actions.openEntry(entry.id)}
                  onPointerDown={(e) => actions.startDrag(entry, "move", e)}
                  onKeyDown={(e) => actions.entryKeys(entry, e)}
                  className={cn(
                    "flex h-full w-full min-w-0 touch-none items-center bg-background-tertiary px-1.5 text-left text-label-xsmall text-content-primary hover:bg-button-secondary-hover",
                    p.startsBefore ? "rounded-l-none" : "rounded-l-md",
                    p.endsAfter ? "rounded-r-none" : "rounded-r-md",
                    selected === entry.id && "ring-1 ring-border-selected ring-inset",
                    dragging === entry.id && "opacity-80 shadow-raised",
                  )}
                >
                  <span className="truncate">{entry.title}</span>
                </button>
                {p.endsAfter ? null : (
                  <span
                    aria-hidden
                    onPointerDown={(e) => actions.startDrag(entry, "resize", e)}
                    className="absolute inset-y-0 right-0 w-2 cursor-ew-resize touch-none"
                  />
                )}
              </div>
            );
          })}
          {pendingColumn >= 0 ? (
            <div className="pointer-events-auto z-10 mx-1" style={{ gridColumn: pendingColumn + 1, gridRow: 1 }}>
              <InlineTitle className="h-[20px] text-paragraph-xsmall" />
            </div>
          ) : null}
          {recordByDay.flatMap((groups, column) => {
            const day = days[column];
            if (day === undefined) return [];
            const room = groups.length > RECORD_LINES ? RECORD_LINES - 1 : RECORD_LINES;
            const lines = groups.slice(0, room).map((g, i) => (
              <button
                key={`${day}:${g.kind}:${g.groupId ?? ""}`}
                type="button"
                onClick={() => actions.openDay(day)}
                className="pointer-events-auto mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-paragraph-xsmall text-content-secondary hover:bg-background-secondary"
                style={{ gridColumn: column + 1, gridRow: lanes + i + 1 }}
              >
                <KindDot kind={g.kind} />
                <span className="truncate">{recordLine(g)}</span>
              </button>
            ));
            if (groups.length <= RECORD_LINES) return lines;
            return [
              ...lines,
              <button
                key={`${day}:more`}
                type="button"
                onClick={() => actions.openDay(day)}
                className="pointer-events-auto mx-1 rounded-md px-1.5 text-left text-paragraph-xsmall text-content-tertiary hover:bg-background-secondary"
                style={{ gridColumn: column + 1, gridRow: lanes + room + 1 }}
              >
                {groups.length - room} more
              </button>,
            ];
          })}
        </div>
      </div>
    </div>
  );
}

function minutesAt(event: PointerEvent<HTMLElement>, column: HTMLElement): number {
  const y = event.clientY - column.getBoundingClientRect().top;
  return Math.max(0, Math.min(MINUTES_PER_DAY, snap((y / HOUR_PX) * 60)));
}

function TimeColumn({ day, plans, pending }: { day: CalendarDay; plans: readonly CalendarEntry[]; pending: PendingEntry | null }) {
  const { timeZone, today, actions, selected, dragging, pinnedNow } = useCalendar();
  // Dragging down empty space marks out a new entry; a click makes it an hour long.
  const [marking, setMarking] = useState<{ from: number; to: number } | null>(null);
  const segments = plans.flatMap((p) => {
    if (p.when.kind !== "timed") return [];
    const seg = segmentOn(p.when, day, timeZone);
    return seg === null ? [] : [{ ...seg, id: p.id }];
  });
  const byId = new Map<string, CalendarEntry>(plans.map((p) => [p.id, p]));
  const pendingSeg = pending?.when.kind === "timed" ? segmentOn(pending.when, day, timeZone) : null;
  const now = useNow(pinnedNow);
  const nowMinutes = day === today ? wallClock(now, timeZone).minutes : null;

  function finishMarking(range: { from: number; to: number }) {
    setMarking(null);
    const [from, to] = range.from <= range.to ? [range.from, range.to] : [range.to, range.from];
    const end = to - from < 15 ? Math.min(MINUTES_PER_DAY, from + 60) : to;
    actions.beginCreate({
      kind: "timed",
      start: instantAt(day, from, timeZone).toISOString(),
      // 1440 minutes is the next midnight.
      end: instantAt(day, end, timeZone).toISOString(),
    });
  }

  return (
    <div
      data-day={day}
      data-timegrid=""
      className="relative touch-none border-l border-border-opaque"
      style={{ backgroundImage: "linear-gradient(to bottom, var(--border-opaque) 1px, transparent 1px)", backgroundSize: `100% ${HOUR_PX}px` }}
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const at = minutesAt(e, e.currentTarget);
        setMarking({ from: at, to: at });
      }}
      onPointerMove={(e) => {
        if (marking === null) return;
        setMarking({ ...marking, to: minutesAt(e, e.currentTarget) });
      }}
      onPointerUp={() => {
        if (marking !== null) finishMarking(marking);
      }}
      onPointerCancel={() => setMarking(null)}
    >
      {layoutDay(segments).map((seg) => {
        const entry = byId.get(seg.id);
        if (entry === undefined || entry.when.kind !== "timed") return null;
        const height = ((visibleEnd(seg) - seg.start) / 60) * HOUR_PX;
        const endsToday = segmentOn(entry.when, day, timeZone)?.end !== MINUTES_PER_DAY;
        return (
          <div
            key={seg.id}
            className="absolute px-0.5"
            style={{
              top: (seg.start / 60) * HOUR_PX,
              height,
              left: `${(seg.column / seg.columns) * 100}%`,
              width: `${100 / seg.columns}%`,
            }}
          >
            <button
              type="button"
              data-entry={entry.id}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
              aria-describedby={ENTRY_KEYS_ID}
              onClick={() => actions.openEntry(entry.id)}
              onPointerDown={(e) => actions.startDrag(entry, "move", e)}
              onKeyDown={(e) => actions.entryKeys(entry, e)}
              className={cn(
                "flex h-full w-full min-w-0 touch-none flex-col overflow-hidden rounded-md border border-border-raised bg-background-tertiary px-1.5 py-0.5 text-left text-label-xsmall text-content-primary hover:bg-button-secondary-hover",
                selected === entry.id && "border-border-selected",
                dragging === entry.id && "opacity-80 shadow-raised",
              )}
            >
              <span className="truncate">{entry.title}</span>
              {height >= 36 ? <span className="truncate text-paragraph-xsmall text-content-tertiary">{whenLine(entry.when, timeZone)}</span> : null}
            </button>
            {endsToday ? (
              <span
                aria-hidden
                onPointerDown={(e) => actions.startDrag(entry, "resize", e)}
                className="absolute inset-x-1 bottom-0 h-1.5 cursor-ns-resize touch-none"
              />
            ) : null}
          </div>
        );
      })}
      {marking !== null ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0.5 rounded-md bg-background-tertiary ring-1 ring-border-accent"
          style={{
            top: (Math.min(marking.from, marking.to) / 60) * HOUR_PX,
            height: Math.max(12, (Math.abs(marking.to - marking.from) / 60) * HOUR_PX),
          }}
        />
      ) : null}
      {pendingSeg !== null ? (
        <div className="absolute inset-x-0.5 z-10" style={{ top: (pendingSeg.start / 60) * HOUR_PX }}>
          <InlineTitle className="h-[22px] text-label-xsmall" />
        </div>
      ) : null}
      {nowMinutes === null ? null : (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 z-[5] h-px bg-content-primary"
          style={{ top: (nowMinutes / 60) * HOUR_PX }}
        >
          <span className="absolute -top-[3px] -left-[3px] size-[7px] rounded-full bg-content-primary" />
        </div>
      )}
    </div>
  );
}

function useNow(pinned: Date | null): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (pinned !== null) return;
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, [pinned]);
  return pinned ?? now;
}
