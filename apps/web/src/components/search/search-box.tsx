import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { SearchOutlineIcon } from "../icons/drawn";
import { inputVariants } from "../ui/field";

// The large input with a search icon as the start enhancer.
export function SearchBox({ className, ...props }: Omit<ComponentProps<"input">, "size">) {
  return (
    <div className={cn("relative", className)}>
      <SearchOutlineIcon className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-content-tertiary" />
      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        className={cn(inputVariants({ size: "large" }), "rounded-xl bg-background-raised pl-13 shadow-raised [&::-webkit-search-cancel-button]:hidden")}
        {...props}
      />
    </div>
  );
}
