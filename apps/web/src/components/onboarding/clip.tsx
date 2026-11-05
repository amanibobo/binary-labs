"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import type { ClipId } from "@/lib/onboarding";
import { CLIP_SIZES } from "./clip-sizes";

// The theme lives on <html data-theme> (lib/theme.ts), so the clips follow it there. The
// server renders the dark set.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function useScheme(): "dark" | "light" {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    () => "dark",
  );
}

// A few silent seconds of the real app (scripts/record-clips.mjs), looping while it's on
// screen. With reduced motion it's the still poster instead.
export function Clip({ id, className }: { id: ClipId; className?: string }) {
  const scheme = useScheme();
  const still = useReducedMotion() === true;
  const video = useRef<HTMLVideoElement>(null);
  const { width, height } = CLIP_SIZES[id];
  const base = `/onboarding/${id}-${scheme}`;

  useEffect(() => {
    const el = video.current;
    if (el === null) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void el.play().catch(() => undefined);
        else el.pause();
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [base, still]);

  const frame = cn("block w-full overflow-hidden rounded-lg border border-border-opaque bg-background-secondary", className);
  if (still) {
    // eslint-disable-next-line @next/next/no-img-element -- a fixed-size poster from public/
    return <img src={`${base}.webp`} alt="" width={width} height={height} className={cn(frame, "h-auto")} />;
  }
  return (
    <video
      key={base}
      ref={video}
      muted
      loop
      playsInline
      preload="none"
      poster={`${base}.webp`}
      width={width}
      height={height}
      aria-hidden
      className={cn(frame, "h-auto")}
    >
      <source src={`${base}.webm`} type='video/webm; codecs="vp9"' />
      <source src={`${base}.mp4`} type="video/mp4" />
    </video>
  );
}
