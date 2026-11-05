"use client";

import { Dialog } from "radix-ui";
import { buttonVariants } from "../ui/button";
import { cn } from "@/lib/cn";
import { Clip } from "./clip";
import { useOnboarding } from "./onboarding-context";

// The first sign-in: one sentence, one clip, and the choice to take the tour or not.
export function Welcome() {
  const { overlay, closeWelcome, startTour } = useOnboarding();
  return (
    <Dialog.Root open={overlay.kind === "welcome"} onOpenChange={(open) => (open ? undefined : closeWelcome())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-background-overlay" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border-raised bg-background-raised p-5 text-content-primary shadow-deep-below focus-visible:outline-none sm:p-6"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (e.currentTarget instanceof HTMLElement) e.currentTarget.querySelector<HTMLElement>("[data-autofocus]")?.focus();
          }}
        >
          <Clip id="search" />
          <Dialog.Title className="mt-5 text-heading-small">Welcome to Binary</Dialog.Title>
          <Dialog.Description className="mt-1.5 text-paragraph-medium text-content-secondary">
            Search everything your lab has made by what&apos;s in it.
          </Dialog.Description>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
            <button type="button" data-autofocus onClick={startTour} className={cn(buttonVariants(), "sm:flex-1")}>
              Take the 1-minute tour
            </button>
            <Dialog.Close className={cn(buttonVariants({ variant: "tertiary" }), "text-content-secondary")}>Skip</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
