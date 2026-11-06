import { addDays, daysBetween, type CalendarDay } from "./calendar-time";

// Where entries sit on the grids. Pure, so the arrangement is tested without a browser.

// An entry as a bar across a week row (a month row). `order` breaks
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
export type MonthRowLines = { lanes: number; days: { records: number; more: number }[] };

export function monthRowLines(placed: readonly PlacedSpan[], recordsPerDay: readonly number[], maxLines: number): MonthRowLines {
  const plansPerDay = recordsPerDay.map((_, day) => placed.filter((p) => p.column <= day && day < p.column + p.length).map((p) => p.lane));
  const usedLanes = placed.reduce((n, p) => Math.max(n, p.lane + 1), 0);
  const fit = (lanes: number) =>
    recordsPerDay.map((records, day) => {
      const hiddenPlans = (plansPerDay[day] ?? []).filter((lane) => lane >= lanes).length;
      const room = maxLines - lanes;
      if (hiddenPlans === 0 && records <= room) return { records, more: 0 };
      const shown = Math.max(0, Math.min(records, room - 1));
      return { records: shown, more: hiddenPlans + records - shown };
    });
  let lanes = Math.min(usedLanes, maxLines);
  let days = fit(lanes);
  // A day that overflows needs a line for "N more"; when every line is a lane, give one back.
  if (lanes === maxLines && days.some((d) => d.more > 0)) {
    lanes -= 1;
    days = fit(lanes);
  }
  return { lanes, days };
}
