import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { ShellData } from "@/lib/shell-data";
import { AccountMenu } from "./account-menu";
import { CommandPalette, PaletteTrigger } from "./command-palette";
import { SearchOutlineIcon } from "./icons/drawn";
import { NeedsLookCountProvider, NeedsLookCountText } from "./labels/needs-look-count";
import { NAV, type ShellLocation } from "./nav";
import { buttonVariants } from "./ui/button";

export function AppShell({ shell, location, children }: { shell: ShellData; location: ShellLocation; children: ReactNode }) {
  return (
    <NeedsLookCountProvider initial={shell.needsLookCount}>
      <CommandPalette>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-background-raised focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <div className="flex min-h-dvh flex-col">
          <header className="sticky top-0 z-30 border-b border-border-opaque bg-background-primary">
            <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4 sm:px-6 md:gap-6">
              <Link href="/" className="flex min-h-11 shrink-0 items-center text-heading-xsmall text-content-primary">
                Binary Labs
              </Link>
              <nav aria-label="Main" className="hidden h-full items-stretch gap-1 md:flex">
                {NAV.map(({ section, href, label }) => (
                  <Link
                    key={section}
                    href={href}
                    aria-current={location.section === section ? "page" : undefined}
                    className={cn(
                      "flex items-center border-b-2 px-3 pt-0.5 text-label-medium transition-colors duration-150 ease-out",
                      location.section === section
                        ? "border-border-selected text-content-primary"
                        : "border-transparent text-content-tertiary hover:text-content-primary",
                    )}
                  >
                    {label}
                    {section === "needs-look" ? <NeedsLookCountText className="ml-1.5 text-content-tertiary tabular-nums" /> : null}
                  </Link>
                ))}
              </nav>
              <div className="ml-auto flex items-center gap-1 sm:gap-2">
                <PaletteTrigger
                  className={cn(buttonVariants({ variant: "tertiary", size: "compact" }), "gap-2 max-sm:w-11 max-sm:px-0")}
                >
                  <SearchOutlineIcon className="size-5" />
                  <span className="sr-only sm:not-sr-only">Search</span>
                  <kbd className="hidden rounded-md border border-border-raised px-1.5 font-sans text-label-xsmall text-content-tertiary sm:inline">
                    ⌘K
                  </kbd>
                </PaletteTrigger>
                <AccountMenu shell={shell} current={location.section} />
              </div>
            </div>
          </header>
          <main id="main" className="flex-1">
            {children}
          </main>
        </div>
      </CommandPalette>
    </NeedsLookCountProvider>
  );
}
