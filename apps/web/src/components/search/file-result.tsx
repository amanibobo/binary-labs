"use client";

import { AnimatePresence, motion } from "motion/react";
import { useId } from "react";
import type { FileHit } from "@/lib/domain";
import { excerpt } from "@/lib/highlight";
import { folderOf, formatDate, matchLine, openInDropboxUrl, otherPlacesLine } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useLabApi } from "../lab-api";
import { buttonVariants } from "../ui/button";
import { Highlighted } from "./highlighted";

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
  const meta = [matchLine(hit.matchedBy), `Modified ${formatDate(primary.modifiedAt)}`, otherPlacesLine(others.length)]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <li className="border-b border-hairline last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex min-h-11 w-full gap-4 rounded-control px-3 py-3.5 text-left transition-colors duration-150 ease-out hover:bg-fill sm:px-4"
      >
        {hit.hasPreview ? (
          // eslint-disable-next-line @next/next/no-img-element -- previews are short-lived presigned redirects
          <img
            src={api.previewUrl(hit.sha256, { view: false })}
            alt=""
            loading="lazy"
            className="size-12 shrink-0 rounded-md border border-hairline bg-fill object-cover"
          />
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[14px] font-medium text-ink">{primary.originalName}</span>
          <span className="block truncate font-mono text-[12.5px] text-muted">{folderOf(primary)}</span>
          {hit.snippet !== null && hit.fileKind !== "image" ? (
            <span className="mt-1.5 line-clamp-2 text-sm text-ink/85">
              <Highlighted text={excerpt(hit.snippet, query, 200)} query={query} />
            </span>
          ) : null}
          <span className="mt-1.5 block text-[13px] text-muted">{meta}</span>
        </span>
      </button>
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
            <div className="grid gap-4 px-3 pb-5 sm:px-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Preview hit={hit} query={query} />
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-ink">{hit.locations.length === 1 ? "Location" : "Locations"}</h3>
                <ul className="mt-2 grid gap-3">
                  {hit.locations.map((location) => (
                    <li key={location.id} className="min-w-0">
                      <p className="font-mono text-[12.5px] [overflow-wrap:anywhere] text-ink">{location.path}</p>
                      <p className="text-[13px] text-muted">Modified {formatDate(location.modifiedAt)}</p>
                      {location.sourceKind === "dropbox" ? (
                        <a
                          href={openInDropboxUrl(location.path)}
                          target="_blank"
                          rel="noreferrer"
                          className={cn(buttonVariants({ variant: "secondary" }), "mt-2")}
                        >
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
      <div className="flex min-h-40 items-center justify-center overflow-hidden rounded-panel border border-hairline bg-fill">
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
      <div className="max-h-72 overflow-auto rounded-panel border border-hairline bg-fill p-4 text-sm whitespace-pre-wrap text-ink">
        <Highlighted text={hit.snippet} query={query} />
      </div>
    );
  }
  return (
    <div className="flex min-h-24 items-center rounded-panel border border-hairline bg-fill p-4 text-sm text-muted">
      No preview for this file yet.
    </div>
  );
}
