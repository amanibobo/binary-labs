"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
import { logError } from "@/lib/log";
import {
  applyEvent,
  checklist,
  summarize,
  tourSteps,
  type ChecklistItem,
  type ChecklistSummary,
  type HelpAnswerId,
  type HintId,
  type OnboardingData,
  type OnboardingEvent,
  type OnboardingState,
  type Progress,
  type TourStep,
} from "@/lib/onboarding";

// Sends one onboarding event to the server. Fixture pages swap in one that keeps it in memory.
export type OnboardingSave = (event: OnboardingEvent) => Promise<void>;

async function postEvent(event: OnboardingEvent): Promise<void> {
  const res = await fetch("/api/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`onboarding ${res.status}`);
}

const SaveContext = createContext<OnboardingSave>(postEvent);
export const OnboardingSaveProvider = SaveContext.Provider;

export type SheetView = { kind: "checklist" } | { kind: "answer"; id: HelpAnswerId };

// One thing at a time: the welcome, a tour step, one hint, or the help sheet, never two.
export type Overlay =
  | { kind: "none" }
  | { kind: "welcome" }
  | { kind: "tour"; index: number }
  | { kind: "hint"; hint: HintId; anchor: Element }
  | { kind: "sheet"; view: SheetView };

type OnboardingValue = {
  role: OnboardingData["role"];
  state: OnboardingState;
  items: ChecklistItem[];
  summary: ChecklistSummary;
  steps: TourStep[];
  overlay: Overlay;
  // Whether this page has the tour's anchors (the Search home).
  tourHere: boolean;
  startTour: () => void;
  goToStep: (index: number) => void;
  endTour: (how: "done" | "skipped") => void;
  closeWelcome: () => void;
  showHint: (hint: HintId, anchor: Element) => void;
  dismissHint: (hint: HintId) => void;
  openSheet: (view: SheetView) => void;
  closeOverlay: () => void;
  hideChecklist: () => void;
  // Something on the checklist just happened on this screen; the server catches up on the next page.
  markDone: (fact: keyof Progress) => void;
};

const OnboardingContext = createContext<OnboardingValue | null>(null);

export function useOnboarding(): OnboardingValue {
  const value = use(OnboardingContext);
  if (value === null) throw new Error("useOnboarding outside OnboardingProvider");
  return value;
}

export function OnboardingProvider({ data, tourHere, children }: { data: OnboardingData; tourHere: boolean; children: ReactNode }) {
  const save = use(SaveContext);
  const router = useRouter();
  const params = useSearchParams();
  const askedForTour = tourHere && params.get("tour") === "1";
  const [state, setState] = useState(data.state);
  const [progress, setProgress] = useState(data.progress);
  const [overlay, setOverlay] = useState<Overlay>(() =>
    askedForTour ? { kind: "tour", index: 0 } : data.state.welcomeSeen ? { kind: "none" } : { kind: "welcome" },
  );

  // A help menu elsewhere sends people here with ?tour=1; follow it (set during render, per React's guidance).
  const [seenAsk, setSeenAsk] = useState(askedForTour);
  if (seenAsk !== askedForTour) {
    setSeenAsk(askedForTour);
    if (askedForTour) setOverlay({ kind: "tour", index: 0 });
  }
  useEffect(() => {
    if (!askedForTour) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("tour");
    window.history.replaceState(null, "", url);
  }, [askedForTour]);

  const value = useMemo((): OnboardingValue => {
    const note = (event: OnboardingEvent) => {
      setState((s) => applyEvent(s, event, new Date().toISOString()));
      save(event).catch((error: unknown) => logError("onboarding.save_failed", { kind: event.kind, error }));
    };
    const steps = tourSteps(data.role);
    const items = checklist({ role: data.role, progress, state });
    const goToStep = (index: number) => {
      note({ kind: "tour_step", step: index + 1 });
      setOverlay({ kind: "tour", index });
    };
    return {
      role: data.role,
      state,
      items,
      summary: summarize(items),
      steps,
      overlay,
      tourHere,
      startTour: () => {
        if (!state.welcomeSeen) note({ kind: "welcome" });
        if (!tourHere) {
          router.push(data.tourHref);
          return;
        }
        goToStep(0);
      },
      goToStep,
      endTour: (how) => {
        note({ kind: how === "done" ? "tour_done" : "tour_skipped" });
        setOverlay({ kind: "none" });
      },
      closeWelcome: () => {
        note({ kind: "welcome" });
        setOverlay({ kind: "none" });
      },
      showHint: (hint, anchor) => setOverlay((o) => (o.kind === "none" ? { kind: "hint", hint, anchor } : o)),
      dismissHint: (hint) => {
        note({ kind: "hint", hint });
        setOverlay({ kind: "none" });
      },
      openSheet: (view) => setOverlay({ kind: "sheet", view }),
      closeOverlay: () => setOverlay({ kind: "none" }),
      hideChecklist: () => note({ kind: "hide_checklist" }),
      markDone: (fact) => setProgress((p) => (p[fact] === null ? { ...p, [fact]: new Date().toISOString() } : p)),
    };
  }, [data.role, data.tourHref, overlay, progress, router, save, state, tourHere]);

  return <OnboardingContext value={value}>{children}</OnboardingContext>;
}
