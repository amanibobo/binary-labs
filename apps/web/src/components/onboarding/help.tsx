"use client";

import { Dialog, DropdownMenu } from "radix-ui";
import { cn } from "@/lib/cn";
import { HELP_ANSWERS, progressText, type HelpAnswer } from "@/lib/onboarding";
import { DeleteIcon } from "../icons/base-web";
import { buttonVariants } from "../ui/button";
import { menuItem, menuSurface } from "../ui/menu";
import { Clip } from "./clip";
import { ChecklistLines } from "./getting-started";
import { useOnboarding, type SheetView } from "./onboarding-context";

// What the ⓘ beside Settings opens: replay the tour, see what's left to set up, or read a short
// answer. The sidebar owns the trigger, so it matches the rows around it.
export function HelpMenuContent({ side, align, onNavigate }: { side: "top" | "right"; align: "start" | "end"; onNavigate?: () => void }) {
  const { summary, startTour, openSheet } = useOnboarding();
  return (
    <DropdownMenu.Portal>
        <DropdownMenu.Content side={side} align={align} sideOffset={6} collisionPadding={12} className={cn(menuSurface, "w-64")}>
          <DropdownMenu.Item
            className={menuItem}
            onSelect={() => {
              onNavigate?.();
              startTour();
            }}
          >
            Take the tour
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={menuItem}
            onSelect={() => {
              onNavigate?.();
              openSheet({ kind: "checklist" });
            }}
          >
            <span className="flex-1">Getting started</span>
            <span className="text-paragraph-small text-content-tertiary tabular-nums">{progressText(summary)}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border-opaque" />
          <DropdownMenu.Group>
            <DropdownMenu.Label className="px-3 pt-1.5 pb-1 text-paragraph-xsmall text-content-tertiary">How do I…</DropdownMenu.Label>
            {HELP_ANSWERS.map((answer) => (
              <DropdownMenu.Item
                key={answer.id}
                className={menuItem}
                onSelect={() => {
                  onNavigate?.();
                  openSheet({ kind: "answer", id: answer.id });
                }}
              >
                {answer.question}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>
        </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

// Help opens in a sheet from the right edge (the bottom on a phone), so the page stays in view.
export function HelpSheet() {
  const { overlay, closeOverlay, openSheet, summary } = useOnboarding();
  const view: SheetView | null = overlay.kind === "sheet" ? overlay.view : null;
  const answer = view?.kind === "answer" ? HELP_ANSWERS.find((a) => a.id === view.id) : undefined;
  const title = view?.kind === "checklist" ? "Getting started" : (answer?.question ?? "");
  return (
    <Dialog.Root open={view !== null} onOpenChange={(open) => (open ? undefined : closeOverlay())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-background-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed z-50 flex animate-fade-in flex-col overflow-y-auto border-border-raised bg-background-raised text-content-primary shadow-deep-below focus-visible:outline-none",
            "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-card border-t",
            "sm:inset-y-0 sm:right-0 sm:left-auto sm:max-h-none sm:w-[400px] sm:rounded-none sm:border-t-0 sm:border-l",
          )}
        >
          <div className="flex items-start gap-3 px-5 pt-5 sm:pt-6">
            <Dialog.Title className="min-w-0 flex-1 pt-1 text-heading-xsmall">{title}</Dialog.Title>
            {view?.kind === "checklist" ? (
              <span className="pt-1.5 text-paragraph-small text-content-tertiary tabular-nums">{progressText(summary)}</span>
            ) : null}
            <Dialog.Close className={cn(buttonVariants({ variant: "tertiary", shape: "square", size: "compact" }), "-mr-2")}>
              <DeleteIcon />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>
          <div className="px-5 pt-3 pb-6">
            {view?.kind === "checklist" ? <ChecklistLines onNavigate={closeOverlay} /> : null}
            {answer === undefined ? null : <Answer answer={answer} onOpen={(id) => openSheet({ kind: "answer", id })} />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Answer({ answer, onOpen }: { answer: HelpAnswer; onOpen: (id: HelpAnswer["id"]) => void }) {
  return (
    <>
      <p className="text-paragraph-medium text-content-secondary">{answer.answer}</p>
      <Clip key={answer.clip} id={answer.clip} className="mx-auto mt-4 max-h-[50dvh] w-auto max-w-full" />
      <h3 className="mt-8 text-label-small text-content-tertiary">More questions</h3>
      <ul className="mt-1 grid gap-0.5">
        {HELP_ANSWERS.filter((a) => a.id !== answer.id).map((other) => (
          <li key={other.id}>
            <button
              type="button"
              onClick={() => onOpen(other.id)}
              className="-mx-2 flex min-h-11 w-[calc(100%+16px)] items-center rounded-lg px-2 text-left text-paragraph-medium text-content-primary transition-colors duration-150 ease-out hover:bg-background-secondary sm:min-h-9"
            >
              {other.question}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
