import type { ReactNode } from "react";
import type { ShellData } from "@/lib/shell-data";
import { CommandPalette } from "./command-palette";
import { NeedsLookCountProvider } from "./labels/needs-look-count";
import { PhoneHeader } from "./phone-header";
import { SidebarContent, type ShellLocation } from "./sidebar";

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
      <div className="flex min-h-dvh">
        <aside className="hidden w-[280px] shrink-0 border-r border-border-opaque bg-background-sidebar md:block">
          <div className="sticky top-0 flex h-dvh flex-col">
            <SidebarContent shell={shell} location={location} />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <PhoneHeader shell={shell} location={location} />
          <main id="main" className="flex-1">
            {children}
          </main>
        </div>
      </div>
    </CommandPalette>
    </NeedsLookCountProvider>
  );
}
