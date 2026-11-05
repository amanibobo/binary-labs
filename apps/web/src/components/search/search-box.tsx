import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { SearchOutlineIcon } from "../icons/drawn";

// The home screen's one big field. Focus darkens the hairline instead of drawing a blue ring,
// since the box holds focus from the moment the page opens. `end` sits inside its right edge.
export function SearchBox({ className, end, ...props }: Omit<ComponentProps<"input">, "size"> & { end?: ReactNode }) {
  return (
    <div className={cn("relative", className)}>
      <SearchOutlineIcon className="pointer-events-none absolute top-1/2 left-4 size-6 -translate-y-1/2 text-content-tertiary" />
      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "h-14 w-full rounded-xl border border-border-opaque bg-background-raised pl-13 text-paragraph-large text-content-primary shadow-raised transition-colors duration-150 ease-out placeholder:text-content-tertiary focus:border-content-tertiary focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden",
          end === undefined ? "pr-4" : "pr-14 sm:pr-28",
        )}
        {...props}
      />
      {end === undefined ? null : <div className="absolute inset-y-0 right-1.5 flex items-center">{end}</div>}
    </div>
  );
}
