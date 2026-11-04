"use client";

import { Dialog } from "radix-ui";
import { useState, type MouseEvent } from "react";
import type { ShellData } from "@/lib/shell-data";
import { cn } from "@/lib/cn";
import { PaletteTrigger } from "./command-palette";
import { DeleteIcon, MenuIcon } from "./icons/base-web";
import { SearchOutlineIcon } from "./icons/drawn";
import { SidebarContent, type ShellLocation } from "./sidebar";
import { buttonVariants } from "./ui/button";

// Below md the sidebar lives in a sheet from the left edge, behind the menu button.
export function PhoneHeader({ shell, location }: { shell: ShellData; location: ShellLocation }) {
  const [open, setOpen] = useState(false);
  const closeOnNavigate = (e: MouseEvent<HTMLElement>) => {
    if (e.target instanceof Element && e.target.closest("a[href], [data-closes-sheet]") !== null) setOpen(false);
  };
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b border-border-opaque bg-background-sidebar px-2 md:hidden">
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger className={buttonVariants({ variant: "tertiary", shape: "square" })}>
          <MenuIcon />
          <span className="sr-only">Menu</span>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-background-overlay" />
          <Dialog.Content
            aria-describedby={undefined}
            onClickCapture={closeOnNavigate}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(320px,calc(100vw-48px))] flex-col border-r border-border-raised bg-background-sidebar focus-visible:outline-none"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border-opaque pr-2 pl-4">
              <Dialog.Title className="text-label-medium">Menu</Dialog.Title>
              <Dialog.Close className={buttonVariants({ variant: "tertiary", shape: "square" })}>
                <DeleteIcon />
                <span className="sr-only">Close menu</span>
              </Dialog.Close>
            </div>
            <SidebarContent shell={shell} location={location} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <p className="min-w-0 flex-1 truncate px-1 text-label-medium">{shell.labName}</p>
      <PaletteTrigger className={cn(buttonVariants({ variant: "tertiary", shape: "square" }))}>
        <SearchOutlineIcon />
        <span className="sr-only">Search</span>
      </PaletteTrigger>
    </header>
  );
}
