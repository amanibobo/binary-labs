import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/app/actions";
import { cn } from "@/lib/cn";
import { CommandPalette } from "./command-palette";

type Section = "search" | "lab";

export function AppShell({
  labName,
  current,
  children,
}: {
  labName: string;
  current: Section;
  children: ReactNode;
}) {
  const navLink = (section: Section, href: string, label: string) => (
    <Link
      href={href}
      aria-current={current === section ? "page" : undefined}
      className={cn(
        "flex min-h-11 items-center rounded-control px-3 text-sm transition-colors duration-150 ease-out hover:bg-fill",
        current === section ? "font-medium text-ink" : "text-muted",
      )}
    >
      {label}
    </Link>
  );
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="border-b border-hairline bg-ground">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-2 px-4 sm:px-6">
          <Link href="/" className="mr-2 flex min-h-11 min-w-0 items-center text-[15px] font-semibold text-ink">
            <span className="truncate">{labName}</span>
          </Link>
          <nav aria-label="Main" className="flex items-center">
            {navLink("search", "/", "Search")}
            {navLink("lab", "/lab", "Lab")}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <CommandPalette />
            <form action={signOut}>
              <button type="submit" className="flex min-h-11 items-center rounded-control px-3 text-sm text-muted transition-colors duration-150 ease-out hover:bg-fill hover:text-ink">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
