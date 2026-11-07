"use client";

import { useReducedMotion } from "motion/react";
import { Dialog, Popover } from "radix-ui";
import { useEffect, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { START_POINTER, stepCount, type TourStep, type TourStepId } from "@/lib/onboarding";
import { CalendarIcon } from "../icons/calendar";
import { BrowseIcon, FlagIcon, InfoIcon, MapIcon, NeedsLookIcon, ProtocolIcon, SearchOutlineIcon, SettingsIcon, UploadIcon } from "../icons/drawn";
import type { IconProps } from "../icons/svg";
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

// Each step wears its tab's sidebar icon, so it's easy to find again in the sidebar or the menu.
const TAB_ICONS = {
  search: SearchOutlineIcon,
  browse: BrowseIcon,
  protocols: ProtocolIcon,
  map: MapIcon,
  calendar: CalendarIcon,
  "needs-look": NeedsLookIcon,
  flags: FlagIcon,
  upload: UploadIcon,
  settings: SettingsIcon,
  help: InfoIcon,
} as const satisfies Record<TourStepId, (props: IconProps) => ReactNode>;

const MENU = '[data-tour~="menu"]';

// Focus lands on the button that moves things on (Next, Got it), not the first thing in the card.
function focusNextButton(e: Event) {
  e.preventDefault();
  if (e.currentTarget instanceof HTMLElement) e.currentTarget.querySelector<HTMLElement>("[data-autofocus]")?.focus();
}

export function Tour() {
  const { overlay, steps, goToStep, endTour } = useOnboarding();
  if (overlay.kind === "start") return <StartPointer />;
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
              side="right"
              align="start"
              sideOffset={PAD + 10}
              collisionPadding={16}
              aria-label={label}
              onOpenAutoFocus={focusNextButton}
              onEscapeKeyDown={onSkip}
              onInteractOutside={(e) => e.preventDefault()}
              onKeyDown={keys}
              className="z-50 w-[340px] animate-fade-in rounded-xl border border-border-raised bg-background-raised p-3 text-content-primary shadow-deep-below focus-visible:outline-none"
            >
              <StepCard {...props} inMenu={false} />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        // A phone gets a bottom sheet; a step whose anchor isn't on this screen sits in the middle.
        <Dialog.Root open>
          <Dialog.Portal>
            <Dialog.Content
              aria-describedby={undefined}
              onOpenAutoFocus={focusNextButton}
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
              <StepCard {...props} compact={!wide} inMenu={spot?.el.matches(MENU) ?? false} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}

// The tab's name, what it's for and when you'd use it. On a phone the tab is behind the menu,
// which is what's spotlit, so the card says so.
function StepCard({ step, index, total, onBack, onNext, onSkip, compact = false, inMenu }: StepProps & { compact?: boolean; inMenu: boolean }) {
  const last = index === total - 1;
  const Icon = TAB_ICONS[step.id];
  return (
    <>
      <Clip id={step.clip} className={compact ? "mx-auto max-h-40 w-auto max-w-full" : "mx-auto max-h-52 w-auto max-w-full"} />
      <div className="mt-3 flex items-center gap-2 px-1">
        <Icon className="size-5 shrink-0 text-content-tertiary" />
        <h2 className="text-label-large text-content-primary">{step.title}</h2>
        {inMenu ? <span className="ml-auto text-paragraph-small text-content-tertiary">In the menu</span> : null}
      </div>
      <p className="mt-1.5 px-1 text-paragraph-medium text-content-primary">{step.what}</p>
      <p className="mt-1 px-1 text-paragraph-medium text-content-secondary">{step.when}</p>
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

// After a finished tour: one line by Protocols on where to begin, gone at Got it or a click
// anywhere else. It isn't stored, so it never comes back.
function StartPointer() {
  const { closeOverlay } = useOnboarding();
  const wide = useWide();
  const [anchor] = useState(() => findAnchor(START_POINTER.anchors));
  useEffect(() => {
    if (anchor === null) closeOverlay();
  }, [anchor, closeOverlay]);
  if (anchor === null) return null;
  return (
    <Popover.Root open onOpenChange={(open) => (open ? undefined : closeOverlay())}>
      <Popover.Anchor virtualRef={{ current: anchor }} />
      <Popover.Portal>
        <Popover.Content
          side={wide ? "right" : "bottom"}
          align={wide ? "center" : "end"}
          sideOffset={10}
          collisionPadding={16}
          aria-label="Where to start"
          onOpenAutoFocus={focusNextButton}
          className="z-50 flex w-[min(360px,calc(100vw-32px))] animate-fade-in items-start gap-3 rounded-xl border border-border-raised bg-background-raised p-3 text-content-primary shadow-deep-below focus-visible:outline-none"
        >
          <p className="flex-1 pt-1 pl-1 text-paragraph-small text-content-primary">{START_POINTER.text}</p>
          <Popover.Close data-autofocus className={cn(buttonVariants({ variant: "secondary", size: "compact" }), "shrink-0")}>
            Got it
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
