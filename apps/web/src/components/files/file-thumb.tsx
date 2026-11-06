"use client";
import type { FileHit } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { useLabApi } from "../lab-api";
import { KindIcon } from "./kind-icon";

// A file row's preview square: 48px on phones, 56px from sm up. Files without a preview get
// their kind icon in the same frame, so every row's text starts at the same edge.
export function FileThumb({ hit, className }: { hit: FileHit; className?: string }) {
  const api = useLabApi();
  const frame = cn("pointer-events-none relative size-12 shrink-0 overflow-hidden rounded-lg border border-border-opaque sm:size-14", className);
  if (hit.hasPreview) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- previews are short-lived presigned redirects
      <img src={api.previewUrl(hit.sha256, { view: false })} alt="" loading="lazy" className={cn(frame, "bg-background-secondary object-cover object-top")} />
    );
  }
  return (
    <span className={cn(frame, "grid place-items-center bg-background-raised")}>
      <KindIcon kind={hit.fileKind} />
    </span>
  );
}
