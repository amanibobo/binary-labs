"use client";

import { useRef, useState } from "react";
import type { EntryWhen } from "@/lib/calendar";
import { cn } from "@/lib/cn";
import { useCalendar } from "./calendar-context";

// A new entry drawn where it was started, waiting for its title. Enter or leaving the field
// saves it; Escape, or leaving it empty, lets it go.
export type PendingEntry = { when: EntryWhen };

export function InlineTitle({ className }: { className?: string }) {
  const { actions } = useCalendar();
  const [title, setTitle] = useState("");
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    actions.finishCreate(value === null || value.trim() === "" ? null : value.trim());
  };
  return (
    <input
      autoFocus
      aria-label="Title of the new entry"
      placeholder="New entry"
      value={title}
      maxLength={200}
      onChange={(e) => setTitle(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(title);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(title)}
      className={cn(
        "w-full min-w-0 rounded-md bg-background-raised px-1.5 text-content-primary shadow-raised ring-1 ring-border-accent outline-none placeholder:text-content-tertiary",
        className,
      )}
    />
  );
}
