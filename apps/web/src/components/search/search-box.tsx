import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { SearchIcon } from "../icons/base-web";
import { inputVariants } from "../ui/field";

// Base Web Input at its large size with a search icon as the start enhancer.
export function SearchBox({ className, ...props }: Omit<ComponentProps<"input">, "size">) {
  return (
    <div className={cn("relative", className)}>
      <SearchIcon className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-content-tertiary" />
      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        className={cn(inputVariants({ size: "large" }), "pl-13 [&::-webkit-search-cancel-button]:hidden")}
        {...props}
      />
    </div>
  );
}
