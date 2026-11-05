"use client";

import Link from "next/link";
import { Dialog, DropdownMenu, Tooltip } from "radix-ui";
import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { signOut } from "@/app/actions";
import { InviteForm } from "@/app/lab/members-section";
import { cn } from "@/lib/cn";
import type { ShellData } from "@/lib/shell-data";
import { PaletteTrigger } from "./command-palette";
import { ChevronDownIcon, DeleteIcon, MenuIcon } from "./icons/base-web";
import { SearchOutlineIcon, SendIcon, SidebarIcon, UploadIcon } from "./icons/drawn";
import { NeedsLookCountText, useNeedsLookCount } from "./labels/needs-look-count";
import { LogoMark } from "./logo";
import { NAV, SETTINGS_NAV, type NavItem, type Section } from "./nav";
import { buttonVariants } from "./ui/button";
import { Dialog as Modal, DialogContent, DialogTrigger } from "./ui/dialog";
import { menuItem, menuSurface } from "./ui/menu";

export const SIDEBAR_COOKIE = "bl-sidebar";

type ShellProps = { shell: ShellData; current: Section };

// Collapsed, the desktop sidebar keeps only its icons and names each one in a tooltip.
const Collapsed = createContext(false);

const itemClass = (active: boolean, collapsed: boolean) =>
  cn(
    "flex min-h-11 items-center rounded-lg text-label-medium transition-colors duration-150 ease-out md:min-h-9",
    collapsed ? "justify-center px-0" : "gap-3 px-3",
    active ? "bg-background-tertiary text-content-primary" : "text-content-secondary hover:bg-background-secondary hover:text-content-primary",
  );

// Only says something when the sidebar is collapsed; expanded, the label is already on screen.
function Tip({ label, children }: { label: ReactNode; children: ReactNode }) {
  const collapsed = use(Collapsed);
  if (!collapsed) return children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={10}
          className="z-50 rounded-md bg-background-inverse-secondary px-2 py-1 text-label-small text-content-inverse-primary shadow-raised"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function NavLink({ item, current, onNavigate }: { item: NavItem; current: Section; onNavigate?: () => void }) {
  const collapsed = use(Collapsed);
  const { count } = useNeedsLookCount();
  const active = item.section === current;
  const label = item.section === "needs-look" && count > 0 ? `${item.label} · ${count}` : item.label;
  return (
    <Tip label={label}>
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        aria-label={collapsed ? label : undefined}
        onClick={onNavigate}
        className={cn(itemClass(active, collapsed), "relative")}
      >
        <item.Icon className={cn("size-5 shrink-0", active ? "text-content-primary" : "text-content-tertiary")} />
        {collapsed ? (
          item.section === "needs-look" && count > 0 ? (
            <span aria-hidden className="absolute top-1.5 right-2.5 size-1.5 rounded-full bg-content-tertiary" />
          ) : null
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.section === "needs-look" ? <NeedsLookCountText className="text-label-small text-content-tertiary tabular-nums" /> : null}
            {item.section === "search" ? (
              <kbd className="hidden rounded-md border border-border-raised px-1.5 font-sans text-label-xsmall text-content-tertiary md:inline">⌘K</kbd>
            ) : null}
          </>
        )}
      </Link>
    </Tip>
  );
}

function Brand({ labName, onNavigate }: { labName: string; onNavigate?: () => void }) {
  const collapsed = use(Collapsed);
  return (
    <Tip label="Binary">
      <Link
        href="/"
        onClick={onNavigate}
        aria-label={collapsed ? "Binary, home" : undefined}
        className={cn("flex min-h-11 min-w-0 items-center rounded-lg", collapsed ? "justify-center" : "flex-1 gap-2.5 px-1")}
      >
        <LogoMark className="h-6 w-auto shrink-0" />
        {collapsed ? null : (
          <span className="min-w-0">
            <span className="block text-label-large text-content-primary">Binary</span>
            <span className="block truncate text-paragraph-xsmall text-content-tertiary">{labName}</span>
          </span>
        )}
      </Link>
    </Tip>
  );
}

// The same contents fill the desktop sidebar and the phone's menu sheet.
function SidebarBody({ shell, current, onNavigate }: ShellProps & { onNavigate?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-3">
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {NAV.map((item) => (
          <NavLink key={item.section} item={item} current={current} onNavigate={onNavigate} />
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-0.5">
        {shell.isAdmin ? <InvitePeople shell={shell} /> : null}
        <div className="mt-2 flex flex-col gap-0.5 border-t border-border-opaque pt-3">
          <NavLink item={SETTINGS_NAV} current={current} onNavigate={onNavigate} />
          <AccountMenu email={shell.email} />
        </div>
      </div>
    </div>
  );
}

// A quiet card above Settings: one click to bring someone into the lab.
function InvitePeople({ shell }: { shell: ShellData }) {
  const collapsed = use(Collapsed);
  const others = shell.memberCount === 1 ? "Just you so far" : `${shell.memberCount} people in the lab`;
  return (
    <Modal>
      <Tip label="Invite people">
        <DialogTrigger
          aria-label={collapsed ? "Invite people" : undefined}
          className={cn(
            "group flex min-h-11 w-full items-center rounded-xl text-left transition-colors duration-150 ease-out",
            collapsed
              ? "justify-center py-1 hover:bg-background-secondary"
              : "gap-3 border border-border-opaque bg-background-secondary px-3 py-2.5 hover:border-border-raised hover:bg-background-tertiary",
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-tint-blue-wash text-tint-blue-ink">
            <SendIcon className="size-[18px] transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </span>
          {collapsed ? null : (
            <span className="min-w-0 flex-1">
              <span className="block text-label-medium text-content-primary">Invite people</span>
              <span className="block truncate text-paragraph-xsmall text-content-tertiary">{others}</span>
            </span>
          )}
        </DialogTrigger>
      </Tip>
      <DialogContent title="Invite people" aria-describedby={undefined}>
        <InviteForm className="px-4 pt-2 pb-6 sm:px-6" />
      </DialogContent>
    </Modal>
  );
}

function AccountMenu({ email }: { email: string }) {
  const collapsed = use(Collapsed);
  return (
    <DropdownMenu.Root>
      <Tip label={email}>
        <DropdownMenu.Trigger aria-label={collapsed ? `Account, ${email}` : undefined} className={cn(itemClass(false, collapsed), "w-full text-left")}>
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-background-tertiary text-label-xsmall text-content-secondary uppercase">
            {email.slice(0, 1)}
          </span>
          {collapsed ? null : (
            <>
              <span className="min-w-0 flex-1 truncate">{email}</span>
              <ChevronDownIcon className="size-4 shrink-0 text-content-tertiary" />
            </>
          )}
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side={collapsed ? "right" : "top"} align={collapsed ? "end" : "start"} sideOffset={6} className={cn(menuSurface, "w-56")}>
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

function rememberCollapsed(collapsed: boolean) {
  document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? "collapsed" : "open"};path=/;max-age=31536000;samesite=lax`;
}

// Desktop: the sidebar beside the page, which folds to an icon rail. The choice is kept in a
// cookie so the next page renders at the right width straight away. ⌘\ toggles it.
export function DesktopFrame({ shell, current, initialCollapsed, children }: ShellProps & { initialCollapsed: boolean; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const toggle = () => {
    rememberCollapsed(!collapsed);
    setCollapsed(!collapsed);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setCollapsed((was) => {
          rememberCollapsed(!was);
          return !was;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleLabel = collapsed ? "Open sidebar" : "Close sidebar";
  return (
    <Collapsed value={collapsed}>
      <Tooltip.Provider delayDuration={250} skipDelayDuration={100}>
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border-opaque bg-background-primary transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex",
            collapsed ? "w-16" : "w-60",
          )}
        >
          <div className={cn("flex items-center px-3 pt-4", collapsed ? "flex-col gap-1" : "gap-1")}>
            <Brand labName={shell.labName} />
            <Tip label={`${toggleLabel} · ⌘\\`}>
              <button
                type="button"
                onClick={toggle}
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                className={cn(buttonVariants({ variant: "tertiary", shape: "square", size: "compact" }), "size-9 shrink-0 text-content-tertiary")}
              >
                <SidebarIcon className="size-5" />
              </button>
            </Tip>
          </div>
          <SidebarBody shell={shell} current={current} />
        </aside>
        <div className={cn("flex min-h-dvh flex-col transition-[padding] duration-200 ease-out motion-reduce:transition-none", collapsed ? "md:pl-16" : "md:pl-60")}>
          {children}
        </div>
      </Tooltip.Provider>
    </Collapsed>
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
        Binary
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
