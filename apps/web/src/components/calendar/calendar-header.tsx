"use client";

import { MODE_KEYS, MODE_NAMES, stepName, viewTitle, type PickerMonth } from "@/lib/calendar-nav";
import { CALENDAR_MODES, type CalendarMode } from "@/lib/calendar-start";
import type { CalendarDay } from "@/lib/calendar-time";
import { cn } from "@/lib/cn";
import { ChevronRightIcon, PlusIcon } from "../icons/base-web";
import { Button } from "../ui/button";
import { MonthPicker } from "./month-picker";

// The title (a button to any month or year), Day · Week · Month · Year, ‹ Today ›, and New
// entry. On a phone the title and New entry take the first line, the rest the second.
export function CalendarHeader({
  mode,
  anchor,
  today,
  onMode,
  onStep,
  onToday,
  onPick,
  onYear,
  onNew,
}: {
  mode: CalendarMode;
  anchor: CalendarDay;
  today: CalendarDay;
  onMode: (mode: CalendarMode) => void;
  onStep: (n: number) => void;
  onToday: () => void;
  onPick: (to: PickerMonth) => void;
  onYear: (year: number) => void;
  onNew: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-2 gap-y-3 px-4 pt-5 pb-3 sm:px-8 sm:pt-8">
      <p aria-live="polite" className="sr-only">
        {viewTitle(mode, anchor)}
      </p>
      <h1 className="order-1 -ml-2 mr-auto min-w-0 text-heading-xsmall sm:text-heading-medium">
        <MonthPicker title={viewTitle(mode, anchor)} anchor={anchor} today={today} onPick={onPick} onYear={mode === "year" ? onYear : undefined} />
      </h1>
      <Button size="compact" className="order-2 max-sm:w-11 max-sm:px-0 md:order-5" onClick={onNew}>
        <PlusIcon className="size-5" />
        <span className="max-sm:sr-only">New entry</span>
      </Button>
      <div aria-hidden className="order-2 basis-full md:hidden" />
      <div
        role="group"
        aria-label="View"
        className="order-3 flex rounded-control bg-background-secondary p-0.5 ring-1 ring-border-opaque ring-inset"
      >
        {CALENDAR_MODES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            aria-keyshortcuts={MODE_KEYS[m]}
            title={`${MODE_NAMES[m]} (${MODE_KEYS[m]})`}
            onClick={() => onMode(m)}
            className={cn(
              "min-h-10 rounded-[8px] px-2 text-label-small transition-colors duration-150 sm:min-h-7 sm:px-3",
              mode === m ? "bg-background-raised text-content-primary shadow-raised" : "text-content-secondary hover:text-content-primary",
            )}
          >
            {MODE_NAMES[m]}
          </button>
        ))}
      </div>
      <div className="order-4 -mr-1 ml-auto flex items-center md:mr-0 md:ml-0">
        <Button variant="tertiary" size="compact" shape="square" className="max-sm:w-9" title={stepName(mode, "previous")} onClick={() => onStep(-1)}>
          <ChevronRightIcon className="size-5 rotate-180" />
          <span className="sr-only">{stepName(mode, "previous")}</span>
        </Button>
        <Button variant="tertiary" size="compact" className="max-sm:px-2" aria-keyshortcuts="T" title="Today (T)" onClick={onToday}>
          Today
        </Button>
        <Button variant="tertiary" size="compact" shape="square" className="max-sm:w-9" title={stepName(mode, "next")} onClick={() => onStep(1)}>
          <ChevronRightIcon className="size-5" />
          <span className="sr-only">{stepName(mode, "next")}</span>
        </Button>
      </div>
    </header>
  );
}
