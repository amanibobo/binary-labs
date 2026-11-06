"use client";

import { Popover } from "radix-ui";
import { useRef, useState, type KeyboardEvent } from "react";
import { MAX_YEAR, MIN_YEAR, monthOf, parseYear, pickerStep, yearOf, type PickerMonth } from "@/lib/calendar-nav";
import { type CalendarDay } from "@/lib/calendar-time";
import { cn } from "@/lib/cn";
import { ChevronDownIcon, ChevronRightIcon } from "../icons/base-web";
import { Button } from "../ui/button";
import { menuSurface } from "../ui/menu";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTH_NAMES = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });
const monthName = (month: number) => MONTH_NAMES.format(new Date(Date.UTC(2000, month, 1)));

// Apple Calendar's way to get around: the title is a button, and it opens a year over the
// twelve months. Picking a month goes there; the year steps with its arrows, a typed year, or
// Page Up and Down.
export function MonthPicker({
  title,
  anchor,
  today,
  onPick,
  onYear,
}: {
  title: string;
  anchor: CalendarDay;
  today: CalendarDay;
  onPick: (to: PickerMonth) => void;
  // The year view takes a typed year as where to go.
  onYear?: (year: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(yearOf(anchor));
  const [yearText, setYearText] = useState(String(yearOf(anchor)));
  const [focusMonth, setFocusMonth] = useState(monthOf(anchor));
  const grid = useRef<HTMLDivElement>(null);
  const yearField = useRef<HTMLInputElement>(null);

  const focusAt = (month: number) => grid.current?.querySelector<HTMLElement>(`[data-month="${month}"]`)?.focus();
  const showYear = (next: number) => {
    setYear(next);
    setYearText(String(next));
  };

  function pick(month: number) {
    setOpen(false);
    onPick({ year, month });
  }

  function gridKeys(event: KeyboardEvent<HTMLButtonElement>, month: number) {
    if (/^\d$/.test(event.key)) {
      // Typing a year starts in the year field.
      event.preventDefault();
      setYearText(event.key);
      yearField.current?.focus();
      return;
    }
    const next = pickerStep({ year, month }, event.key);
    if (next === null) return;
    event.preventDefault();
    showYear(next.year);
    setFocusMonth(next.month);
    focusAt(next.month);
  }

  function yearKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      showYear(Math.min(MAX_YEAR, Math.max(MIN_YEAR, year + (event.key === "ArrowUp" ? 1 : -1))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const typed = parseYear(yearText) ?? year;
      showYear(typed);
      if (onYear !== undefined) {
        setOpen(false);
        onYear(typed);
      } else focusAt(focusMonth);
    }
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          showYear(yearOf(anchor));
          setFocusMonth(monthOf(anchor));
        }
        setOpen(next);
      }}
    >
      <Popover.Trigger className="group inline-flex max-w-full min-w-0 items-center gap-1 rounded-lg px-2 py-0.5 text-left transition-colors duration-150 hover:bg-background-secondary focus-visible:bg-background-secondary data-[state=open]:bg-background-secondary">
        <span className="truncate">{title}</span>
        <span className="sr-only">, change month or year</span>
        <ChevronDownIcon
          aria-hidden
          className="size-5 shrink-0 text-content-tertiary opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          aria-label="Go to a month"
          className={cn(menuSurface, "w-72 max-w-[calc(100vw-32px)] p-3")}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            focusAt(monthOf(anchor));
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <Button variant="tertiary" size="compact" shape="square" disabled={year <= MIN_YEAR} onClick={() => showYear(year - 1)}>
              <ChevronRightIcon className="size-5 rotate-180" />
              <span className="sr-only">Previous year</span>
            </Button>
            <input
              ref={yearField}
              aria-label="Year"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={yearText}
              onChange={(e) => {
                const text = e.target.value.replace(/\D/g, "");
                setYearText(text);
                const typed = parseYear(text);
                if (typed !== null) setYear(typed);
              }}
              onKeyDown={yearKeys}
              onBlur={() => setYearText(String(year))}
              onFocus={(e) => e.currentTarget.select()}
              className="h-9 w-24 rounded-lg bg-transparent text-center text-label-large text-content-primary tabular-nums outline-none hover:bg-background-secondary focus:bg-background-secondary"
            />
            <Button variant="tertiary" size="compact" shape="square" disabled={year >= MAX_YEAR} onClick={() => showYear(year + 1)}>
              <ChevronRightIcon className="size-5" />
              <span className="sr-only">Next year</span>
            </Button>
          </div>
          <div ref={grid} role="group" aria-label={`Months of ${year}`} className="mt-2 grid grid-cols-3 gap-1">
            {MONTHS.map((label, month) => {
              const shown = year === yearOf(anchor) && month === monthOf(anchor);
              const now = year === yearOf(today) && month === monthOf(today);
              return (
                <button
                  key={label}
                  type="button"
                  data-month={month}
                  tabIndex={month === focusMonth ? 0 : -1}
                  aria-label={`${monthName(month)} ${year}${now ? ", this month" : ""}`}
                  aria-current={shown ? "date" : undefined}
                  onClick={() => pick(month)}
                  onKeyDown={(e) => gridKeys(e, month)}
                  onFocus={() => setFocusMonth(month)}
                  className={cn(
                    "relative h-11 rounded-lg text-label-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-selected sm:h-10",
                    shown ? "bg-background-tertiary text-content-primary" : "text-content-secondary hover:bg-background-secondary hover:text-content-primary",
                  )}
                >
                  {label}
                  {now ? <span aria-hidden className="absolute bottom-1.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-content-primary" /> : null}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
