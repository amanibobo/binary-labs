"use client";

import { AnimatePresence, motion } from "motion/react";
import { useId } from "react";
import type { FileHit } from "@/lib/domain";
import { excerpt } from "@/lib/highlight";
import { folderOf, formatDay, matchLine, openTarget, otherPlacesLine } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useLabApi } from "../lab-api";
import { KindIcon } from "../files/kind-icon";
import { PreviewPanel } from "../files/preview-panel";
import { LabelTags, LabelTitle } from "../labels/file-label";
import { useLabels } from "../labels/labels-context";
import { OpenExternalIcon } from "../icons/drawn";
import { buttonVariants } from "../ui/button";
import { When } from "../ui/when";
import { Highlighted } from "./highlighted";

// One search row: the preview, the name, one quiet line (path, then a date), the matching
// text when there is a query, and the label's facts. The whole row toggles the details, so
// that toggle sits underneath as a stretched button and the name and tags, which edit in
// place, sit above it. Open shows on hover and focus; touch opens the row and uses the
// button inside it.
export function FileResult({
  hit,
  query,
  expanded,
  onToggle,
}: {
  hit: FileHit;
  query: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { labelOf } = useLabels();
  const label = labelOf(hit);
  const panelId = useId();
  const [primary, ...others] = hit.locations;
  const open = openTarget(primary);
  const named = label !== null && label.cleanName !== null;
  const title = label?.cleanName ?? primary.originalName;
  // The label's day when it has one (the day the work happened), else when the file was saved.
  const labelDay = label?.date ?? null;
  const showSnippet = query !== "" && hit.snippet !== null && hit.fileKind !== "image";
  const notes = [matchLine(hit.matchedBy), otherPlacesLine(others.length)].filter((part) => part !== null);

  return (
    <li className={cn("group relative rounded-xl transition-colors duration-150 ease-out", expanded && "bg-background-secondary")}>
      <div className="relative flex items-start gap-4 p-3">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          className={cn(
            "absolute inset-0 rounded-xl transition-colors duration-150 ease-out focus-visible:outline-offset-[-2px]",
            !expanded && "hover:bg-background-secondary",
          )}
        >
          <span className="sr-only">Details for {title}</span>
        </button>
        <Thumb hit={hit} />
        <span className="pointer-events-none relative min-w-0 flex-1 pt-0.5">
          <LabelTitle hit={hit} label={label} />
          {/* The notes wrap under the path on narrow screens rather than squeezing it. */}
          <span className="mt-0.5 flex flex-wrap gap-x-1.5 text-paragraph-xsmall text-content-tertiary">
            <span className="flex max-w-full min-w-0 gap-1.5">
              <span className="truncate font-mono">{named ? primary.path : folderOf(primary)}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0">{labelDay === null ? <When iso={primary.modifiedAt} /> : formatDay(labelDay)}</span>
            </span>
            {notes.map((note) => (
              <span key={note} className="flex shrink-0 gap-1.5">
                <span aria-hidden>·</span>
                {note}
              </span>
            ))}
          </span>
          {showSnippet ? (
            <span className="mt-1.5 line-clamp-2 text-paragraph-small text-content-secondary">
              <Highlighted text={excerpt(hit.snippet ?? "", query, 200)} query={query} />
            </span>
          ) : null}
          {label === null ? null : <LabelTags hit={hit} label={label} expanded={expanded} />}
        </span>
        {open === null ? null : (
          <a
            href={open.href}
            target="_blank"
            rel="noreferrer"
            className={cn(
              buttonVariants({ variant: "tertiary", shape: "square", size: "compact" }),
              "relative shrink-0 text-content-secondary opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:hidden",
              expanded && "invisible",
            )}
          >
            <OpenExternalIcon className="size-5" />
            <span className="sr-only">
              {open.label}: {primary.originalName} (opens in a new tab)
            </span>
          </a>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <PreviewPanel
              id={panelId}
              hit={hit}
              query={query}
              className="px-3 pt-1 pb-4 sm:pl-[92px]"
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

// 56px on phones, 64px from sm up. Files without a preview get their kind icon in the same frame,
// so every row's text starts at the same edge.
function Thumb({ hit }: { hit: FileHit }) {
  const api = useLabApi();
  const frame = "pointer-events-none relative size-14 shrink-0 overflow-hidden rounded-lg border border-border-opaque sm:size-16";
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
