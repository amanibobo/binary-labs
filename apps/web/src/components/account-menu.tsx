"use client";

import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { signOut } from "@/app/actions";
import { cn } from "@/lib/cn";
import type { ShellData } from "@/lib/shell-data";
import { ChevronDownIcon, MenuIcon } from "./icons/base-web";
import { NeedsLookCountText } from "./labels/needs-look-count";
import { NAV, type Section } from "./nav";
import { buttonVariants } from "./ui/button";
import { menuItem, menuSurface } from "./ui/menu";

// On phones the tabs are hidden, so this menu carries every section; on wider screens only Settings.
export function AccountMenu({ shell, current }: { shell: ShellData; current: Section }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className={cn(buttonVariants({ variant: "tertiary", size: "compact" }), "max-md:w-11 max-md:px-0")}>
        <MenuIcon className="md:hidden" />
        <span className="hidden max-w-56 truncate md:inline">{shell.email}</span>
        <ChevronDownIcon className="-mr-1 hidden size-5 md:block" />
        <span className="sr-only md:hidden">Account and navigation</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className={cn(menuSurface, "w-72 max-w-[calc(100vw-32px)]")}>
          <div className="border-b border-border-opaque px-4 pt-2 pb-3">
            <p className="truncate text-label-medium">{shell.labName}</p>
            <p className="mt-1 truncate text-paragraph-small text-content-tertiary">{shell.email}</p>
          </div>
          <div className="pt-2">
            {NAV.map(({ section, href, label }) => (
              <DropdownMenu.Item key={section} asChild className={cn(menuItem, section !== "lab" && "md:hidden")}>
                <Link href={href} aria-current={current === section ? "page" : undefined}>
                  {label}
                  {section === "needs-look" ? <NeedsLookCountText className="ml-auto text-content-tertiary tabular-nums" /> : null}
                </Link>
              </DropdownMenu.Item>
            ))}
            <form action={signOut}>
              <DropdownMenu.Item asChild className={menuItem}>
                <button type="submit">Sign out</button>
              </DropdownMenu.Item>
            </form>
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
