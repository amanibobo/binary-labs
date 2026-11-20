import Link from "next/link";
import { cn } from "@/lib/cn";

const VIEWS = [
  { view: "folders", href: "/browse", label: "Dropbox folders" },
  { view: "drive", href: "/drive", label: "Clean names" },
] as const;

export type FilesView = (typeof VIEWS)[number]["view"];

// Browse has two ways to look at the same files: the folders as they are in Dropbox, and
// the lab drive, where every file goes by its clean name.
export function FilesViewSwitch({ current, className }: { current: FilesView; className?: string }) {
  return (
    <nav aria-label="Ways to look at the lab's files" className={cn("flex shrink-0 items-center gap-1 text-label-medium", className)}>
      {VIEWS.map(({ view, href, label }) => (
        <Link
          key={view}
          href={href}
          aria-current={view === current ? "page" : undefined}
          className={cn(
            "rounded-md px-2 py-1 transition-colors duration-150 ease-out",
            view === current ? "bg-background-secondary text-content-primary" : "text-content-tertiary hover:text-content-primary",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
