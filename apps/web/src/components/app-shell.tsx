import type { ReactNode } from "react";
import type { ShellData } from "@/lib/shell-data";
import { CommandPalette } from "./command-palette";
import { NeedsLookCountProvider } from "./labels/needs-look-count";
import type { ShellLocation } from "./nav";
import { PhoneBar, Sidebar } from "./sidebar";

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
        <Sidebar shell={shell} current={location.section} />
        <div className="flex min-h-dvh flex-col md:pl-60">
          <PhoneBar shell={shell} current={location.section} />
          <main id="main" className="flex-1">
            {children}
          </main>
        </div>
      </CommandPalette>
    </NeedsLookCountProvider>
  );
}
