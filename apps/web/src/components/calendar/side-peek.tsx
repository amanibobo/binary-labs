"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { DeleteIcon } from "../icons/base-web";
import { Button } from "../ui/button";

// Notion's side peek: a panel over the right of the calendar that leaves the grid in view and
// usable, so clicking another entry swaps what's in it. Full screen on a phone. Escape closes it.
export function SidePeek({
  labelledBy,
  onClose,
  tools,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  tools?: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    // Focus comes in when the panel opens, unless a field inside asked for it first.
    if (panel.current !== null && !panel.current.contains(document.activeElement)) panel.current.focus();
  }, [labelledBy]);
  return (
    <aside
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          onClose();
        }
      }}
      className="fixed inset-0 z-40 flex animate-fade-in flex-col bg-background-raised text-content-primary outline-none md:inset-y-0 md:right-0 md:left-auto md:w-[min(520px,calc(100vw-280px))] md:border-l md:border-border-raised md:shadow-deep-below"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-1 md:px-4">
        <Button variant="tertiary" size="compact" shape="square" onClick={onClose}>
          <DeleteIcon />
          <span className="sr-only">Close</span>
        </Button>
        <div className="ml-auto flex items-center gap-2">{tools}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-16 md:px-8">{children}</div>
    </aside>
  );
}
