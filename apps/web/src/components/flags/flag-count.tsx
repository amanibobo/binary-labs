"use client";

import { createContext, use, useState, type ReactNode } from "react";

type FlagCount = { count: number; shift: (delta: number) => void };

const FlagCountContext = createContext<FlagCount>({ count: 0, shift: () => {} });

// Open flags nobody has answered: loaded with the page, moved by answers given on it.
export function FlagCountProvider({ initial, children }: { initial: number; children: ReactNode }) {
  const [count, setCount] = useState(initial);
  const shift = (delta: number) => {
    if (delta !== 0) setCount((c) => Math.max(0, c + delta));
  };
  return <FlagCountContext value={{ count, shift }}>{children}</FlagCountContext>;
}

export function useFlagCount(): FlagCount {
  return use(FlagCountContext);
}

// Plain text beside Flags in the sidebar, only when there's something to answer.
export function FlagCountText({ className }: { className?: string }) {
  const { count } = useFlagCount();
  if (count === 0) return null;
  return (
    <>
      <span aria-hidden className={className}>
        {count}
      </span>
      <span className="sr-only">, {count === 1 ? "1 flag to look at" : `${count} flags to look at`}</span>
    </>
  );
}
