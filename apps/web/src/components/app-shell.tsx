import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { AccountMenu } from "./account-menu";
import { CommandPalette } from "./command-palette";
import { NAV, type Section } from "./nav";

export function AppShell({
  labName,
  email,
  current,
  children,
}: {
  labName: string;
  email: string;
  current: Section;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-background-primary focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-border-opaque bg-background-primary">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2 px-4 sm:gap-6 sm:px-6">
          <Link href="/" className="flex min-h-11 shrink-0 items-center text-heading-xsmall text-content-primary">
            Binary Labs
          </Link>
          <nav aria-label="Main" className="hidden h-full items-stretch gap-1 sm:flex">
            {NAV.map((item) => (
              <Link
                key={item.section}
                href={item.href}
                aria-current={current === item.section ? "page" : undefined}
                className={cn(
                  "flex items-center border-b-2 px-3 pt-0.5 text-label-medium transition-colors duration-150 ease-out",
                  current === item.section
                    ? "border-border-selected text-content-primary"
                    : "border-transparent text-content-tertiary hover:text-content-primary",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <CommandPalette />
            <AccountMenu labName={labName} email={email} current={current} />
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
