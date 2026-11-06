import { addDays, daysBetween, MINUTES_PER_DAY, startOfDay, wallClock, type CalendarDay } from "./calendar-time";

// Where entries sit on the grids. Pure, so the arrangement is tested without a browser.

// A timed entry's piece of one day, in wall-clock minutes from that day's midnight. The grid
// is 24 wall-clock hours, so on the day the clocks go back the repeated hour is drawn once
// and two entries in it overlap, as they would on a paper calendar.
export type TimedSegment = { id: string; start: number; end: number };
export type PlacedSegment = TimedSegment & { column: number; columns: number };

// Short entries still get room for a line of text.
export const MIN_SEGMENT_MINUTES = 20;

export function visibleEnd(segment: TimedSegment): number {
  return Math.min(MINUTES_PER_DAY, Math.max(segment.end, segment.start + MIN_SEGMENT_MINUTES));
}

export function segmentOn(when: { start: string; end: string }, day: CalendarDay, timeZone: string): TimedSegment | null {
  const dayStart = startOfDay(day, timeZone).getTime();
  const next = startOfDay(addDays(day, 1), timeZone).getTime();
  const s = Date.parse(when.start);
  const e = Date.parse(when.end);
  if (e <= dayStart || s >= next) return null;
  const start = s <= dayStart ? 0 : wallClock(new Date(s), timeZone).minutes;
  const end = e >= next ? MINUTES_PER_DAY : wallClock(new Date(e), timeZone).minutes;
  return { id: "", start, end: Math.max(start, end) };
}

// Entries that overlap share the width: each cluster of overlapping entries gets as many
// columns as it needs at its busiest, and an entry takes the first column free at its start.
export function layoutDay(segments: readonly TimedSegment[]): PlacedSegment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.id.localeCompare(b.id));
  const placed: PlacedSegment[] = [];
  let cluster: { segment: TimedSegment; column: number }[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const c of cluster) placed.push({ ...c.segment, column: c.column, columns: columnEnds.length });
    cluster = [];
    columnEnds = [];
  };
  for (const segment of sorted) {
    if (segment.start >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    const end = visibleEnd(segment);
    let column = columnEnds.findIndex((e) => e <= segment.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[column] = end;
    }
    cluster.push({ segment, column });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return placed;
}

// An entry as a bar across a week row (the month grid, the week's all-day row). `order` breaks
// ties among entries starting the same day: a timed entry's start minute, all-day first.
export type Span = { id: string; first: CalendarDay; last: CalendarDay; order: number };
export type PlacedSpan = {
  id: string;
  column: number;
  length: number;
  lane: number;
  // The entry goes on past the row's edge.
  startsBefore: boolean;
  endsAfter: boolean;
};

export function layoutSpans(spans: readonly Span[], rowStart: CalendarDay, days = 7): PlacedSpan[] {
  const rowEnd = addDays(rowStart, days - 1);
  const pieces = spans
    .filter((s) => daysBetween(s.first, rowEnd) >= 0 && daysBetween(rowStart, s.last) >= 0)
    .map((s) => {
      const column = Math.max(0, daysBetween(rowStart, s.first));
      const last = Math.min(days - 1, daysBetween(rowStart, s.last));
      return { span: s, column, length: last - column + 1 };
    })
    .sort((a, b) => a.column - b.column || b.length - a.length || a.span.order - b.span.order || a.span.id.localeCompare(b.span.id));
  const laneEnds: number[] = [];
  return pieces.map(({ span, column, length }) => {
    let lane = laneEnds.findIndex((end) => end <= column);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(column + length);
    } else {
      laneEnds[lane] = column + length;
    }
    return {
      id: span.id,
      column,
      length,
      lane,
      startsBefore: daysBetween(span.first, rowStart) > 0,
      endsAfter: daysBetween(rowEnd, span.last) > 0,
    };
  });
}

// A month row holds a fixed number of lines per day. Plans take lanes across the row so a bar
// stays straight; the record's lines fill what's left under them; a day with more than fits
// ends in "N more", which opens the day.
// Each day's record starts under that day's own lowest plan, so one busy day doesn't push the
// rest of the week's record out of sight.
export type MonthRowLines = { lanes: number; days: { start: number; records: number; more: number }[] };

export function monthRowLines(placed: readonly PlacedSpan[], recordsPerDay: readonly number[], maxLines: number): MonthRowLines {
  const plansPerDay = recordsPerDay.map((_, day) => placed.filter((p) => p.column <= day && day < p.column + p.length).map((p) => p.lane));
  const usedLanes = placed.reduce((n, p) => Math.max(n, p.lane + 1), 0);
  const fit = (lanes: number) =>
    recordsPerDay.map((records, day) => {
      const here = plansPerDay[day] ?? [];
      const hiddenPlans = here.filter((lane) => lane >= lanes).length;
      const start = here.filter((lane) => lane < lanes).reduce((n, lane) => Math.max(n, lane + 1), 0);
      const room = maxLines - start;
      if (hiddenPlans === 0 && records <= room) return { start, records, more: 0, crowded: false };
      const shown = Math.max(0, Math.min(records, room - 1));
      return { start, records: shown, more: hiddenPlans + records - shown, crowded: room < 1 };
    });
  let lanes = Math.min(usedLanes, maxLines);
  let days = fit(lanes);
  // A day that overflows needs a line for "N more"; when its lanes fill every line, give one back.
  if (days.some((d) => d.crowded)) {
    lanes -= 1;
    days = fit(lanes);
  }
  return { lanes, days: days.map(({ start, records, more }) => ({ start, records, more })) };
}
