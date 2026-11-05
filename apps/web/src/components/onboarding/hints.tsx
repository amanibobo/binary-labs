"use client";

import { Popover } from "radix-ui";
import { useEffect } from "react";
import { HINTS, type Hint } from "@/lib/onboarding";
import { buttonVariants } from "../ui/button";
import { useOnboarding } from "./onboarding-context";

// How long an anchor has to stay on screen before its hint shows, so nothing pops up mid-scroll.
const SETTLE_MS = 900;

// One-time hints: the first time an anchor (a Check this label, a finished phone upload) is
// fully on screen and nothing else is showing, its hint appears beside it. Seen is stored.
export function Hints() {
  const { overlay, state, showHint, dismissHint } = useOnboarding();
  const idle = overlay.kind === "none";
  const pending = HINTS.filter((hint) => !state.hintsSeen.includes(hint.id))
    .map((hint) => hint.id)
    .join(" ");

  useEffect(() => {
    if (!idle || pending === "") return;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const watching = HINTS.filter((hint) => pending.split(" ").includes(hint.id) && (!hint.coarseOnly || coarse));
    if (watching.length === 0) return;

    const hintOf = new Map<Element, Hint>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const hint = hintOf.get(entry.target);
          if (hint === undefined) continue;
          clearTimeout(timer);
          if (entry.intersectionRatio >= 0.99) timer = setTimeout(() => showHint(hint.id, entry.target), SETTLE_MS);
        }
      },
      { threshold: [0, 0.99] },
    );
    const scan = () => {
      for (const hint of watching) {
        for (const el of document.querySelectorAll(hint.anchor)) {
          if (hintOf.has(el)) continue;
          hintOf.set(el, hint);
          visible.observe(el);
        }
      }
    };
    scan();
    const added = new MutationObserver(scan);
    added.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-hint"] });
    return () => {
      clearTimeout(timer);
      visible.disconnect();
      added.disconnect();
    };
  }, [idle, pending, showHint]);

  if (overlay.kind !== "hint") return null;
  const hint = HINTS.find((h) => h.id === overlay.hint);
  if (hint === undefined) return null;
  return (
    <Popover.Root open onOpenChange={(open) => (open ? undefined : dismissHint(hint.id))}>
      <Popover.Anchor virtualRef={{ current: overlay.anchor }} />
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          hideWhenDetached
          aria-label="Hint"
          // A hint never takes focus from what the person is doing.
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 w-[min(300px,calc(100vw-32px))] animate-fade-in rounded-xl border border-border-raised bg-background-raised p-3 text-content-primary shadow-deep-below focus-visible:outline-none"
        >
          <p className="text-paragraph-small text-content-primary">{hint.text}</p>
          <div className="mt-2.5 flex justify-end">
            <Popover.Close className={buttonVariants({ variant: "secondary", size: "compact" })}>Got it</Popover.Close>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
