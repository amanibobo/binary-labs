"use client";

import { Dialog, DropdownMenu } from "radix-ui";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { HELP_ANSWERS, HELP_GROUPS, helpGroups, progressText, type HelpAnswer, type HelpAnswerId } from "@/lib/onboarding";
import { DeleteIcon } from "../icons/base-web";
import { ChevronSmallIcon } from "../icons/drawn";
import { buttonVariants } from "../ui/button";
import { menuItem, menuSurface } from "../ui/menu";
import { Clip } from "./clip";
import { ChecklistLines } from "./getting-started";
import { useOnboarding, type SheetView } from "./onboarding-context";

// What the ⓘ beside Settings opens: replay the tour, see what's left to set up, or read a short
// answer. The sidebar owns the trigger, so it matches the rows around it.
export function HelpMenuContent({ side, align, onNavigate }: { side: "top" | "right"; align: "start" | "end"; onNavigate?: () => void }) {
  const { summary, startTour, openSheet } = useOnboarding();
  const open = (view: SheetView) => {
    onNavigate?.();
    openSheet(view);
  };
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
        <DropdownMenu.Item className={menuItem} onSelect={() => open({ kind: "answers" })}>
          How do I…
        </DropdownMenu.Item>
        <DropdownMenu.Item className={menuItem} onSelect={() => open({ kind: "checklist" })}>
          <span className="flex-1">Getting started</span>
          <span className="text-paragraph-small text-content-tertiary tabular-nums">{progressText(summary)}</span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

function titleOf(view: SheetView | null, answer: HelpAnswer | undefined): string {
  switch (view?.kind) {
    case undefined:
      return "";
    case "checklist":
      return "Getting started";
    case "answers":
      return "How do I…";
    case "answer":
      return answer?.question ?? "";
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

// Help opens in a centered modal that scales in and eases out; moving between views cross-fades.
export function HelpSheet() {
  const { overlay, closeOverlay, openSheet, summary } = useOnboarding();
  const view: SheetView | null = overlay.kind === "sheet" ? overlay.view : null;
  // Kept through the closing animation, so the modal doesn't empty out as it fades.
  const [shown, setShown] = useState<SheetView | null>(view);
  if (view !== null && view !== shown) setShown(view);
  const answer = shown?.kind === "answer" ? HELP_ANSWERS.find((a) => a.id === shown.id) : undefined;
  const openAnswer = (id: HelpAnswerId) => openSheet({ kind: "answer", id });
  return (
    <Dialog.Root open={view !== null} onOpenChange={(open) => (open ? undefined : closeOverlay())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background-overlay data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          // Focus starts on the modal itself rather than ringing its close button; Tab goes on to the questions.
          tabIndex={-1}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
          }}
          className={cn(
            "fixed inset-0 z-50 m-auto flex h-fit max-h-[min(720px,calc(100dvh-48px))] w-[min(600px,calc(100vw-32px))] flex-col overflow-y-auto",
            "rounded-card border border-border-raised bg-background-raised text-content-primary shadow-deep-below focus-visible:outline-none",
            "data-[state=closed]:animate-modal-out data-[state=open]:animate-modal-in",
          )}
        >
          <div className="flex items-start gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
            <div className="min-w-0 flex-1">
              {shown?.kind === "answer" ? (
                <button
                  type="button"
                  onClick={() => openSheet({ kind: "answers" })}
                  className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-control pr-2 text-label-medium text-content-tertiary transition-colors duration-150 ease-out hover:text-content-primary sm:min-h-8"
                >
                  <ChevronSmallIcon className="size-5 rotate-180" />
                  How do I…
                </button>
              ) : null}
              <Dialog.Title className="pt-1 text-heading-xsmall">{titleOf(shown, answer)}</Dialog.Title>
            </div>
            {shown?.kind === "checklist" ? (
              <span className="pt-1.5 text-paragraph-small text-content-tertiary tabular-nums">{progressText(summary)}</span>
            ) : null}
            <Dialog.Close className={cn(buttonVariants({ variant: "tertiary", shape: "square", size: "compact" }), "-mr-2")}>
              <DeleteIcon />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>
          <div key={shown?.kind === "answer" ? shown.id : (shown?.kind ?? "none")} className="animate-fade-in px-5 pt-3 pb-6 sm:px-6">
            {shown?.kind === "checklist" ? <ChecklistLines onNavigate={closeOverlay} /> : null}
            {shown?.kind === "answers" ? <AnswerList onOpen={openAnswer} /> : null}
            {answer === undefined ? null : <Answer answer={answer} onOpen={openAnswer} />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Every question, under a short heading per group, so the list scans in a few seconds. Two
// columns on a wider screen, so all of it fits without scrolling.
function AnswerList({ onOpen }: { onOpen: (id: HelpAnswerId) => void }) {
  return (
    <div className="gap-8 sm:columns-2">
      {helpGroups().map((group) => (
        <section key={group.id} aria-labelledby={`help-${group.id}`} className="mb-5 break-inside-avoid last:mb-0">
          <h3 id={`help-${group.id}`} className="text-label-small text-content-tertiary">
            {group.title}
          </h3>
          <Questions answers={group.answers} onOpen={onOpen} />
        </section>
      ))}
    </div>
  );
}

function Questions({ answers, onOpen }: { answers: readonly HelpAnswer[]; onOpen: (id: HelpAnswerId) => void }) {
  return (
    <ul className="mt-1 grid gap-0.5">
      {answers.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => onOpen(a.id)}
            className="-mx-2 flex min-h-11 w-[calc(100%+16px)] items-center rounded-lg px-2 text-left text-paragraph-medium text-content-primary transition-colors duration-150 ease-out hover:bg-background-secondary sm:min-h-9"
          >
            {a.question}
          </button>
        </li>
      ))}
    </ul>
  );
}

// One answer, its clip, then the rest of its group to read next.
function Answer({ answer, onOpen }: { answer: HelpAnswer; onOpen: (id: HelpAnswerId) => void }) {
  const group = HELP_GROUPS.find((g) => g.id === answer.group);
  const others = HELP_ANSWERS.filter((a) => a.group === answer.group && a.id !== answer.id);
  return (
    <>
      <p className="text-paragraph-medium text-content-secondary">{answer.answer}</p>
      {answer.clip === null ? null : <Clip key={answer.clip} id={answer.clip} className="mx-auto mt-4 max-h-[50dvh] w-auto max-w-full" />}
      {others.length === 0 || group === undefined ? null : (
        <>
          <h3 className="mt-8 text-label-small text-content-tertiary">More in {group.title.toLowerCase()}</h3>
          <Questions answers={others} onOpen={onOpen} />
        </>
      )}
    </>
  );
}
