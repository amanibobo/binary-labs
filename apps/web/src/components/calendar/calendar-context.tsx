"use client";

import { createContext, use, type KeyboardEvent, type PointerEvent } from "react";
import { KIND_COLORS, type CalendarEntry, type CalendarEntryId, type EntryWhen, type RecordKind } from "@/lib/calendar";
import type { CalendarDay } from "@/lib/calendar-time";
import type { Experiment, Person } from "@/lib/domain";
import type { InstrumentId, ProtocolId } from "@/lib/ids";
import type { AuthorNames } from "@/lib/protocols";
import { cn } from "@/lib/cn";

// What the lab's lists offer the editor and the filters.
export type CalendarLists = {
  experiments: readonly Experiment[];
  people: readonly Person[];
  // Live instruments can be booked; a revoked one still names old entries.
  instruments: readonly { id: InstrumentId; name: string; live: boolean }[];
  protocols: readonly { id: ProtocolId; title: string }[];
  authors: AuthorNames;
};

export type DragMode = "move" | "resize";

// What the grids hand back up: opening things, starting a new entry, dragging and the arrow keys.
export type CalendarActions = {
  openEntry: (id: CalendarEntryId) => void;
  openDay: (day: CalendarDay) => void;
  // Starts a new entry in place, waiting for its title.
  beginCreate: (when: EntryWhen) => void;
  // The new entry's title, or null to let it go.
  finishCreate: (title: string | null) => void;
  startDrag: (entry: CalendarEntry, mode: DragMode, event: PointerEvent<HTMLElement>) => void;
  entryKeys: (entry: CalendarEntry, event: KeyboardEvent<HTMLElement>) => void;
};

export type CalendarContext = {
  timeZone: string;
  today: CalendarDay;
  lists: CalendarLists;
  actions: CalendarActions;
  // The entry open in the side peek, drawn selected on the grid.
  selected: CalendarEntryId | null;
  // An entry mid-drag, drawn where it would land.
  dragging: CalendarEntryId | null;
};

const Context = createContext<CalendarContext | null>(null);
export const CalendarProvider = Context.Provider;

export function useCalendar(): CalendarContext {
  const ctx = use(Context);
  if (ctx === null) throw new Error("useCalendar needs a CalendarProvider");
  return ctx;
}

// The record's kinds wear the chart palette's hues, one each, as a small dot beside words
// that already say the kind.
export function KindDot({ kind, className }: { kind: RecordKind; className?: string }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", className)} style={{ background: `var(--chart-${KIND_COLORS[kind]})` }} />;
}

// Every entry on a grid points at this sentence, said once on the page.
export const ENTRY_KEYS_ID = "calendar-entry-keys";
export const ENTRY_KEYS_HELP = "Alt and the arrow keys move it; add Shift to change its end.";
