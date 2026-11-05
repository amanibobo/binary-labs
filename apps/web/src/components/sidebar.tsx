"use client";

import Link from "next/link";
import { Dialog, DropdownMenu } from "radix-ui";
import { useState } from "react";
import { signOut } from "@/app/actions";
import { cn } from "@/lib/cn";
import type { ShellData } from "@/lib/shell-data";
import { PaletteTrigger } from "./command-palette";
import { ChevronDownIcon, DeleteIcon, MenuIcon } from "./icons/base-web";
import { SearchOutlineIcon, UploadIcon } from "./icons/drawn";
import { NeedsLookCountText } from "./labels/needs-look-count";
import { LogoMark } from "./logo";
import { NAV, SETTINGS_NAV, type NavItem, type Section } from "./nav";
import { buttonVariants } from "./ui/button";
import { menuItem, menuSurface } from "./ui/menu";

type ShellProps = { shell: ShellData; current: Section };

const itemClass = (active: boolean) =>
  cn(
    "flex min-h-11 items-center gap-3 rounded-lg px-3 text-label-medium transition-colors duration-150 ease-out md:min-h-9",
    active ? "bg-background-tertiary text-content-primary" : "text-content-secondary hover:bg-background-secondary hover:text-content-primary",
  );

function NavLink({ item, current, onNavigate }: { item: NavItem; current: Section; onNavigate?: () => void }) {
  const active = item.section === current;
  return (
    <Link href={item.href} aria-current={active ? "page" : undefined} onClick={onNavigate} className={itemClass(active)}>
      <item.Icon className={cn("size-5 shrink-0", active ? "text-content-primary" : "text-content-tertiary")} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.section === "needs-look" ? <NeedsLookCountText className="text-label-small text-content-tertiary tabular-nums" /> : null}
      {item.section === "search" ? (
        <kbd className="hidden rounded-md border border-border-raised px-1.5 font-sans text-label-xsmall text-content-tertiary md:inline">⌘K</kbd>
      ) : null}
    </Link>
  );
}

function Brand({ labName, onNavigate }: { labName: string; onNavigate?: () => void }) {
  return (
    <Link href="/" onClick={onNavigate} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1">
      <LogoMark className="h-6 w-auto shrink-0" />
      <span className="min-w-0">
        <span className="block text-label-large text-content-primary">Binary Labs</span>
        <span className="block truncate text-paragraph-xsmall text-content-tertiary">{labName}</span>
      </span>
    </Link>
  );
}

// The same contents fill the desktop sidebar and the phone's menu sheet.
function SidebarBody({ shell, current, onNavigate }: ShellProps & { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {NAV.map((item) => (
          <NavLink key={item.section} item={item} current={current} onNavigate={onNavigate} />
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-0.5 border-t border-border-opaque pt-3">
        <NavLink item={SETTINGS_NAV} current={current} onNavigate={onNavigate} />
        <AccountMenu email={shell.email} />
      </div>
    </div>
  );
}

function AccountMenu({ email }: { email: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className={cn(itemClass(false), "w-full text-left")}>
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-background-tertiary text-label-xsmall text-content-secondary uppercase">
          {email.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1 truncate">{email}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-content-tertiary" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="start" sideOffset={6} className={cn(menuSurface, "w-56")}>
          <form action={signOut}>
            <DropdownMenu.Item asChild className={menuItem}>
              <button type="submit">Sign out</button>
            </DropdownMenu.Item>
          </form>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Sidebar({ shell, current }: ShellProps) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border-opaque bg-background-primary md:flex">
      <div className="px-3 pt-4">
        <Brand labName={shell.labName} />
      </div>
      <SidebarBody shell={shell} current={current} />
    </aside>
  );
}

// Phones keep a slim top bar: the logo, Upload, search, and a menu that opens the sidebar as a sheet.
export function PhoneBar({ shell, current }: ShellProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b border-border-opaque bg-background-primary px-3 md:hidden">
      <Link href="/" className="mr-auto flex min-h-11 items-center gap-2 px-1 text-label-large text-content-primary">
        <LogoMark className="h-6 w-auto" />
        Binary Labs
      </Link>
      <Link
        href="/upload"
        aria-current={current === "upload" ? "page" : undefined}
        className={cn(buttonVariants({ variant: "secondary", size: "compact" }), "min-h-11 gap-1.5 pl-2.5")}
      >
        <UploadIcon className="size-5" />
        Upload
      </Link>
      <PaletteTrigger className={cn(buttonVariants({ variant: "tertiary", shape: "square", size: "compact" }), "size-11")}>
        <SearchOutlineIcon className="size-5" />
        <span className="sr-only">Search</span>
      </PaletteTrigger>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger className={cn(buttonVariants({ variant: "tertiary", shape: "square", size: "compact" }), "size-11")}>
          <MenuIcon />
          <span className="sr-only">Menu</span>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-background-overlay" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(18rem,85vw)] flex-col border-r border-border-opaque bg-background-primary focus-visible:outline-none"
          >
            <Dialog.Title className="sr-only">Menu</Dialog.Title>
            <div className="flex items-center gap-2 px-3 pt-3">
              <Brand labName={shell.labName} onNavigate={close} />
              <Dialog.Close className={cn(buttonVariants({ variant: "tertiary", shape: "square", size: "compact" }), "size-11")}>
                <DeleteIcon />
                <span className="sr-only">Close</span>
              </Dialog.Close>
            </div>
            <SidebarBody shell={shell} current={current} onNavigate={close} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </header>
  );
}
