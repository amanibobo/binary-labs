import { cookies } from "next/headers";
import type { ReactNode } from "react";
import type { ShellData } from "@/lib/shell-data";
import { CommandPalette } from "./command-palette";
import { NeedsLookCountProvider } from "./labels/needs-look-count";
import type { ShellLocation } from "./nav";
import { DesktopFrame, PhoneBar, SIDEBAR_COOKIE } from "./sidebar";

export async function AppShell({ shell, location, children }: { shell: ShellData; location: ShellLocation; children: ReactNode }) {
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";
  return (
    <NeedsLookCountProvider initial={shell.needsLookCount}>
      <CommandPalette>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-background-raised focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <DesktopFrame shell={shell} current={location.section} initialCollapsed={collapsed}>
          <PhoneBar shell={shell} current={location.section} />
          <main id="main" className="flex-1">
            {children}
          </main>
        </DesktopFrame>
      </CommandPalette>
    </NeedsLookCountProvider>
  );
}
