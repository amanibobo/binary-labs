"use client";

import { AnimatePresence, motion } from "motion/react";
import { useId } from "react";
import type { FileHit } from "@/lib/domain";
import { excerpt } from "@/lib/highlight";
import { folderOf, formatDate, matchLine, openTarget, otherPlacesLine } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useLabApi } from "../lab-api";
import { KindIcon } from "../files/kind-icon";
import { PreviewPanel } from "../files/preview-panel";
import { LabelTags, LabelTitle } from "../labels/file-label";
import { useLabels } from "../labels/labels-context";
import { OpenExternalIcon } from "../icons/drawn";
import { buttonVariants } from "../ui/button";
import { dataRow } from "../ui/data-table";
import { Highlighted } from "./highlighted";

// One row of a raised results list: kind icon, name, path, the matching text
// and why it matched, with Open in Dropbox as the end action. The whole row
// toggles the details, so that toggle sits underneath as a stretched button and
// the name and tags, which edit in place, sit above it.
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
  const api = useLabApi();
  const { labelOf } = useLabels();
  const label = labelOf(hit);
  const panelId = useId();
  const [primary, ...others] = hit.locations;
  const open = openTarget(primary);
  const named = label !== null && label.cleanName !== null;
  const title = label?.cleanName ?? primary.originalName;
  const meta = [matchLine(hit.matchedBy), `Modified ${formatDate(primary.modifiedAt)}`, otherPlacesLine(others.length)]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <li className={cn(dataRow, "group", expanded && "bg-background-secondary")}>
      <div className="relative flex items-stretch">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          className={cn(
            "absolute inset-0 transition-colors duration-150 ease-out focus-visible:outline-offset-[-2px]",
            !expanded && "hover:bg-background-secondary",
          )}
        >
          <span className="sr-only">Details for {title}</span>
        </button>
        <span className="pointer-events-none relative flex shrink-0 pt-4 pl-4 sm:pl-5">
          <KindIcon kind={hit.fileKind} className="mt-0.5" />
        </span>
        <span className="pointer-events-none relative min-w-0 flex-1 py-4 pr-2 pl-4">
          <LabelTitle hit={hit} label={label} />
          {named ? (
            <span className="mt-0.5 block truncate font-mono text-paragraph-xsmall text-content-secondary">{primary.originalName}</span>
          ) : null}
          <span className={cn("block truncate font-mono text-paragraph-xsmall text-content-tertiary", !named && "mt-1")}>
            {folderOf(primary)}
          </span>
          {hit.snippet !== null && hit.fileKind !== "image" ? (
            <span className="mt-2 line-clamp-2 text-paragraph-small text-content-secondary">
              <Highlighted text={excerpt(hit.snippet, query, 200)} query={query} />
            </span>
          ) : null}
          {label === null ? null : <LabelTags hit={hit} label={label} expanded={expanded} />}
          <span className="mt-2 block text-paragraph-xsmall text-content-tertiary">{meta}</span>
        </span>
        {hit.hasPreview ? (
          // eslint-disable-next-line @next/next/no-img-element -- previews are short-lived presigned redirects
          <img
            src={api.previewUrl(hit.sha256, { view: false })}
            alt=""
            loading="lazy"
            className="pointer-events-none relative my-4 hidden size-12 shrink-0 rounded-lg border border-border-opaque bg-background-secondary object-cover sm:block"
          />
        ) : null}
        {open === null ? null : (
          <a
            href={open.href}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "tertiary", shape: "square" }), "relative mx-2 mt-3 shrink-0 self-start text-content-secondary sm:mt-4")}
          >
            <OpenExternalIcon />
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
            <PreviewPanel id={panelId} hit={hit} query={query} className="px-4 pt-2 pb-6 sm:pr-5 sm:pl-14" />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}
