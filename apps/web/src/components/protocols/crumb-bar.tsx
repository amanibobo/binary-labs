import { cn } from "@/lib/cn";
import { Breadcrumbs, type Crumb } from "../ui/breadcrumbs";

// The breadcrumb bar of a page under Protocols. `width` is the page's own column, so the
// crumbs line up with the title under them.
export function CrumbBar({ items, width = "max-w-3xl sm:px-8" }: { items: readonly Crumb[]; width?: string }) {
  return (
    <div className="border-b border-border-opaque">
      <div className={cn("mx-auto flex h-14 w-full items-center px-4", width)}>
        <Breadcrumbs items={[{ label: "Protocols", href: "/protocols" }, ...items]} />
      </div>
    </div>
  );
}
