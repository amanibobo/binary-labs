"use client";

import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { Sha256 } from "@/lib/ids";
import { FlagIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";

type Marks = { counts: ReadonlyMap<Sha256, number>; want: (sha: Sha256) => void };

const MarksContext = createContext<Marks>({ counts: new Map(), want: () => {} });

// The rows on screen ask for their files' open flags; asks made in the same moment go as one
// request, and each file is asked about once per page.
export function FlagMarksProvider({ children }: { children: ReactNode }) {
  const api = useLabApi();
  const [counts, setCounts] = useState<ReadonlyMap<Sha256, number>>(new Map());
  const asked = useRef(new Set<Sha256>());
  const queue = useRef(new Set<Sha256>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const shas = [...queue.current];
    queue.current.clear();
    if (shas.length === 0) return;
    const controller = new AbortController();
    api
      .flagMarks(shas, controller.signal)
      .then((found) =>
        setCounts((prev) => {
          const next = new Map(prev);
          for (const sha of shas) next.set(sha, found[sha] ?? 0);
          return next;
        }),
      )
      // A mark that didn't load leaves the row as it is; the opened row still lists its flags.
      .catch(() => undefined);
  }, [api]);

  const want = useCallback(
    (sha: Sha256) => {
      if (asked.current.has(sha)) return;
      asked.current.add(sha);
      queue.current.add(sha);
      timer.current ??= setTimeout(flush, 30);
    },
    [flush],
  );

  // No cleanup that cancels the timer: under Strict Mode's remount the asked files wouldn't be
  // asked again, and a late answer after unmounting is dropped by React anyway.
  return <MarksContext value={{ counts, want }}>{children}</MarksContext>;
}

export function useFlagMark(sha: Sha256): number {
  const { counts, want } = use(MarksContext);
  useEffect(() => want(sha), [sha, want]);
  return counts.get(sha) ?? 0;
}

// Amber, like Check this: the one mark on a row that says a result needs a look.
export const flagTag =
  "inline-flex h-6 items-center gap-1 rounded-md bg-background-warning px-2 text-label-xsmall text-content-warning max-sm:h-8";

export function FlagMark({ sha, className }: { sha: Sha256; className?: string }) {
  const count = useFlagMark(sha);
  if (count === 0) return null;
  return (
    <span className={cn(flagTag, className)}>
      <FlagIcon className="size-3.5" />
      {count === 1 ? "Flagged" : `${count} flags`}
    </span>
  );
}
