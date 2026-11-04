import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export function SearchIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={cn("size-[18px]", className)}>
      <circle cx="8.5" cy="8.5" r="5.75" stroke="currentColor" strokeWidth="1.6" />
      <path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function SearchBox({ className, ...props }: ComponentProps<"input">) {
  return (
    <div className={cn("relative", className)}>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted" />
      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        className="h-14 w-full rounded-panel border border-hairline bg-surface pr-4 pl-11 text-[17px] text-ink placeholder:text-muted/80 transition-colors duration-150 ease-out hover:border-ink/30 focus-visible:outline-offset-[-1px] [&::-webkit-search-cancel-button]:hidden"
        {...props}
      />
    </div>
  );
}
