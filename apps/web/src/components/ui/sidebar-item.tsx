import { cn } from "@/lib/cn";

// A sidebar row: nav links and folder tree rows. The current one sits on a raised fill with a hairline edge.
export function sidebarItemClass(active: boolean): string {
  return cn(
    "group flex min-h-11 min-w-0 items-center gap-2.5 rounded-control border px-2.5 text-label-medium transition-colors duration-150 ease-out md:min-h-9",
    active
      ? "border-border-raised bg-background-secondary text-content-primary shadow-raised"
      : "border-transparent text-content-secondary hover:bg-background-secondary hover:text-content-primary",
  );
}

export function SidebarCount({ value, className }: { value: number; className?: string }) {
  return <span className={cn("ml-auto shrink-0 pl-2 text-label-small text-content-tertiary tabular-nums", className)}>{value}</span>;
}

export function SidebarGroupLabel({ children, id }: { children: string; id?: string }) {
  return (
    <h2 id={id} className="px-2.5 pt-6 pb-2 text-label-small text-content-tertiary">
      {children}
    </h2>
  );
}
