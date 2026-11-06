"use client";

import { AnimatePresence, motion } from "motion/react";
import { useId, useState, type KeyboardEvent } from "react";
import type { FileHit } from "@/lib/domain";
import { excerpt } from "@/lib/highlight";
import { folderOf, formatDay, matchLine, openTarget, otherPlacesLine } from "@/lib/format";
import { isRowKey, rowStep } from "@/lib/row-keys";
import { rowSummary } from "@/lib/row-summary";
import { cn } from "@/lib/cn";
import { useLabApi } from "../lab-api";
import { KindIcon } from "../files/kind-icon";
import { PreviewPanel } from "../files/preview-panel";
import { CheckMark, LabelsSection, RowName, SummaryLine, TagList } from "../labels/file-label";
import { useLabels } from "../labels/labels-context";
import { OpenExternalIcon } from "../icons/drawn";
import { FlagMark } from "../flags/flag-marks";
import { buttonVariants } from "../ui/button";
import { When } from "../ui/when";
import { Highlighted } from "./highlighted";

// One file row, quiet until it's opened: the preview, the name with Check this or a flag when
// there is one, one muted line (where it lives, then a date), the matching text for a query,
// and one line of the label (experiment and person, and the tags behind their count). The
// whole row toggles the opened view, where the labels edit; that toggle sits underneath as a
// stretched button, so the tag count above it takes its own clicks. Open shows on hover and
// focus; touch opens the row and uses the button inside it. Arrow keys move between rows.
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
  const summary = rowSummary(label);
  const panelId = useId();
  const tagsId = useId();
  const [tagsOpen, setTagsOpen] = useState(false);
  const [primary, ...others] = hit.locations;
  const open = openTarget(primary);
  const named = label !== null && label.cleanName !== null;
  const title = label?.cleanName ?? primary.originalName;
  // The label's day when it has one (the day the work happened), else when the file was saved.
  const labelDay = label?.date ?? null;
  const showSnippet = query !== "" && hit.snippet !== null && hit.fileKind !== "image";
  const notes = [matchLine(hit.matchedBy), otherPlacesLine(others.length)].filter((part) => part !== null);
  const check = summary.kind === "labeled" && summary.check;

  return (
    <li
      className={cn("group relative rounded-xl transition-colors duration-150 ease-out", expanded && "bg-background-secondary")}
      onKeyDown={(e) => {
        // Escape inside the opened row closes it; a field being edited keeps its own Escape.
        if (e.key === "Escape" && expanded && !e.defaultPrevented) {
          e.preventDefault();
          onToggle();
          e.currentTarget.querySelector<HTMLElement>("[data-row-toggle]")?.focus();
        }
      }}
    >
      <div className="relative flex items-start gap-4 p-3">
        <button
          type="button"
          data-row-toggle
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          onKeyDown={moveBetweenRows}
          className={cn(
            "absolute inset-0 rounded-xl transition-colors duration-150 ease-out focus-visible:outline-offset-[-2px]",
            !expanded && "hover:bg-background-secondary",
          )}
        >
          <span className="sr-only">
            Details for {title}
            {check ? ", check this label" : ""}
          </span>
        </button>
        <Thumb hit={hit} />
        <span data-tour="label" className="pointer-events-none relative min-w-0 flex-1">
          <span className="flex min-w-0 items-start gap-2">
            <RowName hit={hit} label={label} />
            {check ? <CheckMark className="mt-px" /> : null}
            <FlagMark sha={hit.sha256} className="mt-px h-5 shrink-0 px-1.5 max-sm:h-5" />
          </span>
          {expanded ? null : (
            <SummaryLine summary={summary} tagsOpen={tagsOpen} onToggleTags={() => setTagsOpen((o) => !o)} tagsId={tagsId} title={title} />
          )}
          {!expanded && tagsOpen && summary.kind === "labeled" && summary.tags.length > 0 ? <TagList tags={summary.tags} id={tagsId} /> : null}
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
            <PreviewPanel id={panelId} hit={hit} query={query} labels={<LabelsSection hit={hit} />} className="px-3 pt-1 pb-5 sm:pl-[84px]" />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

// Up and Down step between the rows of one list, Home and End go to its ends, and Up from the
// first row goes back to the search box when there is one.
function moveBetweenRows(e: KeyboardEvent<HTMLButtonElement>) {
  if (!isRowKey(e.key)) return;
  const list = e.currentTarget.closest("ul");
  if (list === null) return;
  const toggles = [...list.querySelectorAll<HTMLElement>(":scope > li [data-row-toggle]")];
  const index = toggles.indexOf(e.currentTarget);
  const next = rowStep({ key: e.key, index, count: toggles.length });
  if (next !== null) {
    e.preventDefault();
    toggles[next]?.focus();
  } else if (e.key === "ArrowUp" && index === 0) {
    const box = document.querySelector<HTMLElement>('[data-tour~="search-box"]');
    if (box !== null) {
      e.preventDefault();
      box.focus();
    }
  }
}

// 48px on phones, 56px from sm up. Files without a preview get their kind icon in the same frame,
// so every row's text starts at the same edge.
function Thumb({ hit }: { hit: FileHit }) {
  const api = useLabApi();
  const frame = "pointer-events-none relative size-12 shrink-0 overflow-hidden rounded-lg border border-border-opaque sm:size-14";
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
