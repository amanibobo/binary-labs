"use client";

import { AnimatePresence, motion } from "motion/react";
import { useId } from "react";
import type { FileHit } from "@/lib/domain";
import { excerpt } from "@/lib/highlight";
import { folderOf, formatDate, matchLine, openInDropboxUrl, otherPlacesLine } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useLabApi } from "../lab-api";
import { FILE_KIND_ICONS, OpenExternalIcon } from "../icons/drawn";
import { buttonVariants } from "../ui/button";
import { Highlighted } from "./highlighted";

// A Base Web ListItem: file-kind artwork in a 64px column, then name, path and
// meta, with Open in Dropbox as the end action. The divider is inset past the artwork.
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
  const panelId = useId();
  const [primary, ...others] = hit.locations;
  const KindIcon = FILE_KIND_ICONS[hit.fileKind];
  const meta = [matchLine(hit.matchedBy), `Modified ${formatDate(primary.modifiedAt)}`, otherPlacesLine(others.length)]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <li className="relative after:absolute after:right-0 after:bottom-0 after:left-16 after:h-px after:bg-border-opaque last:after:hidden">
      <div className="flex items-stretch">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          className={cn(
            "flex min-h-16 min-w-0 flex-1 items-start text-left transition-colors duration-150 ease-out hover:bg-button-tertiary-hover focus-visible:outline-offset-[-2px]",
            expanded && "bg-background-secondary hover:bg-background-secondary",
          )}
        >
          <span className="flex h-16 w-16 shrink-0 items-center justify-center">
            <KindIcon className="text-content-secondary" />
          </span>
          <span className="min-w-0 flex-1 py-3 pr-2">
            <span className="block truncate font-mono text-label-medium text-content-primary">{primary.originalName}</span>
            <span className="mt-1 block truncate font-mono text-paragraph-xsmall text-content-tertiary">{folderOf(primary)}</span>
            {hit.snippet !== null && hit.fileKind !== "image" ? (
              <span className="mt-2 line-clamp-2 text-paragraph-small text-content-secondary">
                <Highlighted text={excerpt(hit.snippet, query, 200)} query={query} />
              </span>
            ) : null}
            <span className="mt-2 block text-paragraph-xsmall text-content-tertiary">{meta}</span>
          </span>
          {hit.hasPreview ? (
            // eslint-disable-next-line @next/next/no-img-element -- previews are short-lived presigned redirects
            <img
              src={api.previewUrl(hit.sha256, { view: false })}
              alt=""
              loading="lazy"
              className="my-3 mr-2 hidden size-12 shrink-0 rounded-lg bg-background-secondary object-cover sm:block"
            />
          ) : null}
        </button>
        {primary.sourceKind === "dropbox" ? (
          <a
            href={openInDropboxUrl(primary.path)}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "tertiary", shape: "square" }), "my-2 mr-2 shrink-0 text-content-secondary")}
          >
            <OpenExternalIcon />
            <span className="sr-only">
              Open {primary.originalName} in Dropbox (opens in a new tab)
            </span>
          </a>
        ) : null}
      </div>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            id={panelId}
            key="panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="grid gap-6 pt-4 pr-4 pb-6 pl-4 sm:pl-16 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Preview hit={hit} query={query} />
              <div className="min-w-0">
                <h3 className="text-label-medium text-content-primary">{hit.locations.length === 1 ? "Location" : "Locations"}</h3>
                <ul className="mt-3 grid gap-4">
                  {hit.locations.map((location) => (
                    <li key={location.id} className="min-w-0">
                      <p className="font-mono text-paragraph-small [overflow-wrap:anywhere] text-content-primary">{location.path}</p>
                      <p className="mt-1 text-paragraph-small text-content-tertiary">Modified {formatDate(location.modifiedAt)}</p>
                      {location.sourceKind === "dropbox" ? (
                        <a
                          href={openInDropboxUrl(location.path)}
                          target="_blank"
                          rel="noreferrer"
                          className={cn(buttonVariants({ variant: "secondary", size: "compact" }), "mt-3")}
                        >
                          <OpenExternalIcon className="size-5" />
                          Open in Dropbox
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

function Preview({ hit, query }: { hit: FileHit; query: string }) {
  const api = useLabApi();
  if (hit.hasPreview) {
    return (
      <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-lg bg-background-secondary">
        {/* eslint-disable-next-line @next/next/no-img-element -- previews are short-lived presigned redirects */}
        <img
          src={api.previewUrl(hit.sha256, { view: true })}
          alt={`Preview of ${hit.locations[0].originalName}`}
          className="max-h-[420px] w-full object-contain"
        />
      </div>
    );
  }
  if (hit.snippet !== null) {
    return (
      <div className="max-h-72 overflow-auto rounded-lg bg-background-secondary p-4 text-paragraph-small whitespace-pre-wrap text-content-primary">
        <Highlighted text={hit.snippet} query={query} />
      </div>
    );
  }
  return (
    <div className="flex min-h-24 items-center rounded-lg bg-background-secondary p-4 text-paragraph-small text-content-tertiary">
      No preview for this file yet.
    </div>
  );
}
