"use client";

import { useRef } from "react";
import type { CalendarEntry } from "@/lib/calendar";
import { whenLine } from "@/lib/calendar-edit";
import { repeatLine, type ChangeScope } from "@/lib/calendar-repeat";
import { formatCalendarDay, wallClock } from "@/lib/calendar-time";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDock } from "../ui/dialog";
import { useCalendar } from "./calendar-context";

export type ScopeAsk = { entry: CalendarEntry; answer: (scope: ChangeScope | null) => void };

// "Only this one, or all of them?" for a change to an occurrence of a repeating entry. Enter
// takes the first answer, so a keyboard move is Alt and an arrow, then Enter.
export function ScopeQuestion({ ask }: { ask: ScopeAsk | null }) {
  const { timeZone } = useCalendar();
  const first = useRef<HTMLButtonElement>(null);
  if (ask === null) return null;
  const { entry, answer } = ask;
  const rep = entry.repeat;
  const day = entry.when.kind === "allDay" ? entry.when.first : wallClock(new Date(entry.when.start), timeZone).day;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : answer(null))}>
      <DialogContent
        title={`Change “${entry.title}”`}
        className="sm:w-[min(440px,calc(100vw-80px))]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          first.current?.focus();
        }}
      >
        <p className="px-4 pt-2 text-paragraph-medium text-content-secondary sm:px-6">
          {rep === null ? null : `${repeatLine(rep.rule, rep.firstOn)}. `}
          This one is {formatCalendarDay(day, "medium")}, {whenLine(entry.when, timeZone).replace(/^All day$/, "all day")}.
        </p>
        <DialogDock className="pt-5">
          <Button ref={first} onClick={() => answer("one")}>
            Only this one
          </Button>
          <Button variant="secondary" onClick={() => answer("all")}>
            {rep === null ? "All of them" : `All ${rep.count}`}
          </Button>
        </DialogDock>
      </DialogContent>
    </Dialog>
  );
}
