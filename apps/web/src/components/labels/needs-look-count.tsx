"use client";

import { createContext, use, useState, type ReactNode } from "react";

type NeedsLookCount = { count: number; shift: (delta: number) => void };

const NeedsLookCountContext = createContext<NeedsLookCount>({ count: 0, shift: () => {} });

// The page loads the count once; edits on this page move it so the nav doesn't go stale.
export function NeedsLookCountProvider({ initial, children }: { initial: number; children: ReactNode }) {
  const [count, setCount] = useState(initial);
  const shift = (delta: number) => {
    if (delta !== 0) setCount((c) => Math.max(0, c + delta));
  };
  return <NeedsLookCountContext value={{ count, shift }}>{children}</NeedsLookCountContext>;
}

export function useNeedsLookCount(): NeedsLookCount {
  return use(NeedsLookCountContext);
}

// Plain text, and only when there is something to look at.
export function NeedsLookCountText({ className }: { className?: string }) {
  const { count } = useNeedsLookCount();
  if (count === 0) return null;
  return (
    <>
      <span aria-hidden className={className}>
        {count}
      </span>
      <span className="sr-only">, {count === 1 ? "1 file" : `${count} files`}</span>
    </>
  );
}
