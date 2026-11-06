"use client";

import { entryDays, recordLine, type CalendarEntry, type RecordGroup } from "@/lib/calendar";
import { layoutSpans, monthRowLines, type PlacedSpan } from "@/lib/calendar-layout";
import { dayNumber, formatCalendarDay, formatTime, monthGrid, sameMonth, wallClock, weekOf, type CalendarDay } from "@/lib/calendar-time";
import { cn } from "@/lib/cn";
import { ENTRY_KEYS_ID, KindDot, useCalendar } from "./calendar-context";
import { InlineTitle, type PendingEntry } from "./inline-title";

// Notion's month: a quiet grid of hairlines, the day's number at the top left (today's in a
// small filled circle), and everything on a day as one-line items. Plans come first, as bars
// that run across the days they cover; the record follows as counts.
const MAX_LINES = 4;
const LINE = 22;
const HEAD = 30;
export const MONTH_ROW_HEIGHT = HEAD + MAX_LINES * LINE + 8;

export function MonthView({
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
  const weeks = monthGrid(anchor);
  return (
    <div role="grid" aria-label={formatCalendarDay(anchor, "month")} className="border-t border-l border-border-opaque select-none">
      <div role="row" className="grid grid-cols-7">
        {weekOf(anchor).map((day) => (
          <div key={day} role="columnheader" className="border-r border-b border-border-opaque px-2 py-1.5 text-paragraph-xsmall text-content-tertiary">
            {formatCalendarDay(day, "weekdayShort")}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <MonthRow key={week[0]} week={week} anchor={anchor} plans={plans} record={record} pending={pending} />
      ))}
    </div>
  );
}

function MonthRow({
  week,
  anchor,
  plans,
  record,
  pending,
}: {
  week: CalendarDay[];
  anchor: CalendarDay;
  plans: readonly CalendarEntry[];
  record: readonly RecordGroup[];
  pending: PendingEntry | null;
}) {
  const { timeZone, actions } = useCalendar();
  const rowStart = week[0] ?? anchor;
  const byId = new Map<string, CalendarEntry>(plans.map((p) => [p.id, p]));
  const placed = layoutSpans(
    plans.map((p) => ({ id: p.id, ...entryDays(p.when, timeZone), order: p.when.kind === "allDay" ? 0 : 1 + wallClock(new Date(p.when.start), timeZone).minutes })),
    rowStart,
  );
  const recordByDay = week.map((day) => record.filter((g) => g.day === day));
  const lines = monthRowLines(placed, recordByDay.map((r) => r.length), MAX_LINES);
  const pendingColumn = pending?.when.kind === "allDay" ? week.indexOf(pending.when.first) : -1;

  return (
    <div role="row" className="relative grid grid-cols-7" style={{ height: MONTH_ROW_HEIGHT }}>
      {week.map((day) => (
        <DayCell key={day} day={day} inMonth={sameMonth(day, anchor)} />
      ))}
      <div
        className="pointer-events-none absolute inset-x-0 grid grid-cols-7"
        style={{ top: HEAD, gridTemplateRows: `repeat(${MAX_LINES}, ${LINE}px)` }}
      >
        {placed
          .filter((p) => p.lane < lines.lanes)
          .map((p) => {
            const entry = byId.get(p.id);
            return entry === undefined ? null : <PlanBar key={p.id} entry={entry} placed={p} />;
          })}
        {recordByDay.flatMap((groups, column) => {
          const day = week[column];
          if (day === undefined) return [];
          const fit = lines.days[column] ?? { records: 0, more: 0 };
          const shown = groups.slice(0, fit.records).map((g, i) => (
            <button
              key={`${g.kind}:${g.groupId ?? ""}`}
              type="button"
              onClick={() => actions.openDay(day)}
              className="pointer-events-auto mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-paragraph-xsmall text-content-secondary hover:bg-background-secondary"
              style={{ gridColumn: column + 1, gridRow: lines.lanes + i + 1 }}
            >
              <KindDot kind={g.kind} />
              <span className="truncate">{recordLine(g)}</span>
            </button>
          ));
          if (fit.more === 0) return shown;
          return [
            ...shown,
            <button
              key="more"
              type="button"
              onClick={() => actions.openDay(day)}
              className="pointer-events-auto mx-1 rounded-md px-1.5 text-left text-paragraph-xsmall text-content-tertiary hover:bg-background-secondary hover:text-content-primary"
              style={{ gridColumn: column + 1, gridRow: lines.lanes + fit.records + 1 }}
            >
              {fit.more} more
            </button>,
          ];
        })}
        {pending !== null && pendingColumn >= 0 ? (
          <div className="pointer-events-auto z-10 mx-1" style={{ gridColumn: pendingColumn + 1, gridRow: Math.min(lines.lanes, MAX_LINES - 1) + 1 }}>
            <InlineTitle className="h-[20px] text-paragraph-xsmall" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DayCell({ day, inMonth }: { day: CalendarDay; inMonth: boolean }) {
  const { today, actions } = useCalendar();
  const isToday = day === today;
  const label = formatCalendarDay(day, "long");
  return (
    <div role="gridcell" data-day={day} className={cn("relative border-r border-b border-border-opaque", !inMonth && "bg-background-sidebar/40")}>
      {/* Empty space starts a new entry on the day, as in Notion. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label={`New entry on ${label}`}
        onClick={() => actions.beginCreate({ kind: "allDay", first: day, last: day })}
        className="absolute inset-0 cursor-default"
      />
      <button
        type="button"
        onClick={() => actions.openDay(day)}
        aria-label={`${label}${isToday ? ", today" : ""}`}
        aria-current={isToday ? "date" : undefined}
        className={cn(
          "relative mt-1 ml-1 grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-label-xsmall tabular-nums transition-colors duration-150",
          isToday
            ? "bg-content-primary text-content-inverse-primary"
            : inMonth
              ? "text-content-primary hover:bg-background-secondary"
              : "text-content-tertiary hover:bg-background-secondary",
        )}
      >
        {dayNumber(day) === 1 ? `${formatCalendarDay(day, "monthShort")} 1` : dayNumber(day)}
      </button>
    </div>
  );
}

// A plan on the month grid: a soft bar for whole days, or "9 AM Title" for a timed one.
function PlanBar({ entry, placed }: { entry: CalendarEntry; placed: PlacedSpan }) {
  const { timeZone, actions, selected, dragging } = useCalendar();
  const spansDays = placed.length > 1 || placed.startsBefore || placed.endsAfter;
  const bar = entry.when.kind === "allDay" || spansDays;
  const time = entry.when.kind === "timed" ? formatTime(new Date(entry.when.start), timeZone) : null;
  return (
    <div
      className={cn("pointer-events-auto relative min-w-0 py-px", placed.startsBefore ? "pl-0" : "pl-1", placed.endsAfter ? "pr-0" : "pr-1")}
      style={{ gridColumn: `${placed.column + 1} / span ${placed.length}`, gridRow: placed.lane + 1 }}
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
          "flex h-full w-full min-w-0 touch-none items-center gap-1.5 px-1.5 text-left text-label-xsmall transition-colors duration-150",
          bar ? "bg-background-tertiary text-content-primary hover:bg-button-secondary-hover" : "text-content-primary hover:bg-background-secondary",
          placed.startsBefore ? "rounded-l-none" : "rounded-l-md",
          placed.endsAfter ? "rounded-r-none" : "rounded-r-md",
          selected === entry.id && "ring-1 ring-border-selected ring-inset",
          dragging === entry.id && "opacity-80 shadow-raised",
        )}
      >
        {bar ? null : <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-content-tertiary" />}
        {time === null || placed.startsBefore ? null : <span className="shrink-0 text-content-tertiary">{time}</span>}
        <span className="truncate">{entry.title}</span>
      </button>
      {entry.when.kind === "allDay" && !placed.endsAfter ? (
        <span
          aria-hidden
          onPointerDown={(e) => actions.startDrag(entry, "resize", e)}
          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize touch-none"
        />
      ) : null}
    </div>
  );
}
