"use client";

import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { signOut } from "@/app/actions";
import { cn } from "@/lib/cn";
import { NeedsLookCountText } from "./labels/needs-look-count";
import { NAV, type Section } from "./nav";
import { ChevronDownIcon, MenuIcon } from "./icons/base-web";
import { buttonVariants } from "./ui/button";
import { menuItem, menuSurface } from "./ui/menu";

export function AccountMenu({ labName, email, current }: { labName: string; email: string; current: Section }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className={cn(buttonVariants({ variant: "tertiary", size: "compact" }), "max-sm:w-11 max-sm:px-0")}>
        <MenuIcon className="sm:hidden" />
        <span className="hidden max-w-56 truncate sm:inline">{email}</span>
        <ChevronDownIcon className="-mr-1 hidden size-5 sm:block" />
        <span className="sr-only sm:hidden">Account and navigation</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className={cn(menuSurface, "w-72 max-w-[calc(100vw-32px)]")}>
          <div className="border-b border-border-opaque px-4 pt-2 pb-3">
            <p className="truncate text-label-medium">{labName}</p>
            <p className="mt-1 truncate text-paragraph-small text-content-tertiary">{email}</p>
          </div>
          <div className="pt-2">
            {NAV.map((item) => (
              <DropdownMenu.Item key={item.section} asChild className={cn(menuItem, item.section === "lab" ? "" : "sm:hidden")}>
                <Link href={item.href} aria-current={current === item.section ? "page" : undefined}>
                  {item.label}
                  {item.section === "needs-look" ? <NeedsLookCountText className="text-content-tertiary" /> : null}
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
