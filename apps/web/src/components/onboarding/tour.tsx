"use client";

import { useReducedMotion } from "motion/react";
import { Dialog, Popover } from "radix-ui";
import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { stepCount, type TourStep } from "@/lib/onboarding";
import { buttonVariants } from "../ui/button";
import { Clip } from "./clip";
import { useOnboarding } from "./onboarding-context";

const WIDE = "(min-width: 640px)";

function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => true);
}

// The first anchor that's actually on screen; a sidebar link is display:none on a phone, so
// the phone's menu button stands in for it.
export function findAnchor(selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (el.getClientRects().length > 0 && el.checkVisibility({ visibilityProperty: true })) return el;
    }
  }
  return null;
}

// Brings the anchor into the part of the screen the step leaves clear: the middle on a
// desktop, above the bottom sheet on a phone. Sticky anchors (the phone's menu) stay put.
function bringIntoView(el: Element, wide: boolean, smooth: boolean) {
  const rect = el.getBoundingClientRect();
  const top = wide ? 16 : 72;
  const bottom = wide ? window.innerHeight - 16 : window.innerHeight * 0.5;
  if (rect.top >= top && rect.bottom <= bottom) return;
  const target = wide ? (window.innerHeight - rect.height) / 2 : top;
  window.scrollBy({ top: rect.top - target, behavior: smooth ? "smooth" : "auto" });
}

type Spot = { el: Element; rect: DOMRect } | null;

// Follows the anchor while the step is up, so the ring stays on it through scrolling and layout.
// "measuring" until the first frame, so a step never flashes in the wrong place.
function useSpot(step: TourStep, wide: boolean): Spot | "measuring" {
  const smooth = useReducedMotion() !== true;
  const [spot, setSpot] = useState<Spot | "measuring">("measuring");
  useEffect(() => {
    const el = findAnchor(step.anchors);
    if (el !== null) bringIntoView(el, wide, smooth);
    let last = "";
    let frame = requestAnimationFrame(function tick() {
      const rect = el?.getBoundingClientRect() ?? null;
      const key = rect === null ? "none" : `${rect.x} ${rect.y} ${rect.width} ${rect.height}`;
      if (key !== last) {
        last = key;
        setSpot(el === null || rect === null ? null : { el, rect });
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [step, wide, smooth]);
  return spot;
}

const PAD = 6;

// The page dims gently and a soft ring sits around the anchor. Pointer events stop here, so
// the tour never clicks through by accident.
function Dim({ spot }: { spot: Spot }) {
  if (spot === null) return <div aria-hidden className="fixed inset-0 z-40 animate-fade-in bg-background-overlay" />;
  const { rect } = spot;
  return (
    <div aria-hidden className="fixed inset-0 z-40">
      <div
        className="absolute animate-fade-in rounded-xl transition-[top,left,width,height] duration-300 ease-out"
        style={{
          top: rect.top - PAD,
          left: rect.left - PAD,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
          boxShadow: "0 0 0 3px color-mix(in srgb, var(--content-primary) 28%, transparent), 0 0 0 200vmax var(--background-overlay)",
        }}
      />
    </div>
  );
}

export function Tour() {
  const { overlay, steps, goToStep, endTour } = useOnboarding();
  if (overlay.kind !== "tour") return null;
  const step = steps[overlay.index];
  if (step === undefined) return null;
  const last = overlay.index === steps.length - 1;
  return (
    <TourStepView
      key={step.id}
      step={step}
      index={overlay.index}
      total={steps.length}
      onBack={overlay.index > 0 ? () => goToStep(overlay.index - 1) : null}
      onNext={() => (last ? endTour("done") : goToStep(overlay.index + 1))}
      onSkip={() => endTour("skipped")}
    />
  );
}

type StepProps = { step: TourStep; index: number; total: number; onBack: (() => void) | null; onNext: () => void; onSkip: () => void };

function TourStepView(props: StepProps) {
  const wide = useWide();
  const spot = useSpot(props.step, wide);
  const { onBack, onNext, onSkip } = props;
  const keys = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      onNext();
    } else if (e.key === "ArrowLeft" && onBack !== null) {
      e.preventDefault();
      onBack();
    }
  };
  const focusNext = (e: Event) => {
    e.preventDefault();
    if (e.currentTarget instanceof HTMLElement) e.currentTarget.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  };
  const label = `Tour, ${stepCount(props.index, props.total)}`;
  if (spot === "measuring") return null;

  return (
    <>
      <Dim spot={spot} />
      {wide && spot !== null ? (
        <Popover.Root open modal>
          <Popover.Anchor virtualRef={{ current: spot.el }} />
          <Popover.Portal>
            <Popover.Content
              side={props.step.side}
              align="start"
              sideOffset={PAD + 10}
              collisionPadding={16}
              aria-label={label}
              onOpenAutoFocus={focusNext}
              onEscapeKeyDown={onSkip}
              onInteractOutside={(e) => e.preventDefault()}
              onKeyDown={keys}
              className="z-50 w-[340px] animate-fade-in rounded-xl border border-border-raised bg-background-raised p-3 text-content-primary shadow-deep-below focus-visible:outline-none"
            >
              <StepCard {...props} />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        // A phone gets a bottom sheet; a step whose anchor isn't on this screen sits in the middle.
        <Dialog.Root open>
          <Dialog.Portal>
            <Dialog.Content
              aria-describedby={undefined}
              onOpenAutoFocus={focusNext}
              onEscapeKeyDown={onSkip}
              onInteractOutside={(e) => e.preventDefault()}
              onKeyDown={keys}
              className={cn(
                "fixed z-50 animate-fade-in border-border-raised bg-background-raised text-content-primary shadow-deep-below focus-visible:outline-none",
                wide
                  ? "top-1/2 left-1/2 w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-xl border p-3"
                  : "inset-x-0 bottom-0 rounded-t-card border-t px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))]",
              )}
            >
              <Dialog.Title className="sr-only">{label}</Dialog.Title>
              <StepCard {...props} compact={!wide} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}

function StepCard({ step, index, total, onBack, onNext, onSkip, compact = false }: StepProps & { compact?: boolean }) {
  const last = index === total - 1;
  return (
    <>
      <Clip id={step.clip} className={compact ? "mx-auto max-h-40 w-auto max-w-full" : "mx-auto max-h-52 w-auto max-w-full"} />
      <p className="mt-3 px-1 text-paragraph-medium text-content-primary">{step.text}</p>
      <div className="mt-3 flex items-center gap-2">
        <span className="mr-auto pl-1 text-paragraph-small text-content-tertiary tabular-nums">{stepCount(index, total)}</span>
        <button type="button" onClick={onSkip} className={cn(buttonVariants({ variant: "tertiary", size: "compact" }), "text-content-secondary")}>
          Skip
        </button>
        {onBack === null ? null : (
          <button type="button" onClick={onBack} className={buttonVariants({ variant: "secondary", size: "compact" })}>
            Back
          </button>
        )}
        <button type="button" data-autofocus onClick={onNext} className={buttonVariants({ size: "compact" })}>
          {last ? "Done" : "Next"}
        </button>
      </div>
    </>
  );
}
