"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { progressText, type ChecklistItem } from "@/lib/onboarding";
import { ChecklistMarkIcon } from "../icons/drawn";
import { useOnboarding } from "./onboarding-context";

// One line per item, each going where it's done. Done lines stay, checked and quieter.
export function ChecklistLines({ onNavigate }: { onNavigate?: () => void }) {
  const { items, startTour } = useOnboarding();
  return (
    <ul className="grid gap-0.5">
      {items.map((item) => (
        <li key={item.id}>
          <ItemLine item={item} onNavigate={onNavigate} onTour={startTour} />
        </li>
      ))}
    </ul>
  );
}

const lineClass = (done: boolean) =>
  cn(
    "-mx-2 flex min-h-11 w-[calc(100%+16px)] items-center gap-3 rounded-lg px-2 text-left text-paragraph-medium transition-colors duration-150 ease-out hover:bg-background-secondary sm:min-h-9",
    done ? "text-content-tertiary" : "text-content-primary",
  );

function ItemLine({ item, onNavigate, onTour }: { item: ChecklistItem; onNavigate?: () => void; onTour: () => void }) {
  const done = item.doneAt !== null;
  const body = (
    <>
      <ChecklistMarkIcon done={done} className="size-5 text-content-tertiary" />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      <span className="sr-only">{done ? " (done)" : ""}</span>
    </>
  );
  switch (item.action.kind) {
    case "link":
      return (
        <Link href={item.action.href} onClick={onNavigate} className={lineClass(done)}>
          {body}
        </Link>
      );
    case "tour":
      return (
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            onTour();
          }}
          className={lineClass(done)}
        >
          {body}
        </button>
      );
    default: {
      const _exhaustive: never = item.action;
      return _exhaustive;
    }
  }
}

// The Search home's quiet card, until everything's done or it's hidden.
export function GettingStartedCard({ className }: { className?: string }) {
  const { summary, state, hideChecklist } = useOnboarding();
  if (state.checklistHidden || summary.kind === "complete") return null;
  return (
    <section aria-labelledby="getting-started" className={cn("rounded-xl border border-border-opaque px-4 pt-3 pb-2", className)}>
      <div className="flex items-baseline gap-2">
        <h2 id="getting-started" className="text-label-medium text-content-primary">
          Getting started
        </h2>
        <span className="text-paragraph-small text-content-tertiary tabular-nums">{progressText(summary)}</span>
        <button
          type="button"
          onClick={hideChecklist}
          className="-mr-2 ml-auto min-h-11 rounded-control px-2 text-paragraph-small text-content-tertiary transition-colors duration-150 ease-out hover:bg-background-secondary hover:text-content-primary sm:min-h-8"
        >
          Hide
        </button>
      </div>
      <div className="mt-1">
        <ChecklistLines />
      </div>
    </section>
  );
}
