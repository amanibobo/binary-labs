import Link from "next/link";
import { cn } from "@/lib/cn";
import { ChevronSmallIcon } from "../icons/drawn";

export type Crumb = { label: string; href: string };

// The last crumb is the current page and isn't a link.
export function Breadcrumbs({ items, className }: { items: readonly Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1 text-label-large">
        {items.map((crumb, i) => {
          const last = i === items.length - 1;
          return (
            <li key={crumb.href} className={cn("flex min-w-0 items-center gap-1", last ? "shrink" : "shrink-0 max-sm:hidden")}>
              {i > 0 ? <ChevronSmallIcon className="size-4 shrink-0 text-content-tertiary max-sm:hidden" /> : null}
              {last ? (
                <span aria-current="page" className="truncate px-1 text-content-primary">
                  {crumb.label}
                </span>
              ) : (
                <Link
                  href={crumb.href}
                  className="max-w-48 truncate rounded-md px-1 text-content-tertiary transition-colors duration-150 ease-out hover:text-content-primary"
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
