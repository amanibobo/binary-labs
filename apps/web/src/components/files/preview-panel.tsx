"use client";

import type { FileHit } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { formatDate, openInDropboxUrl } from "@/lib/format";
import { OpenExternalIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { Highlighted } from "../search/highlighted";
import { buttonVariants } from "../ui/button";

// The opened state of a file row: preview on the left, every place it lives on the right.
export function PreviewPanel({ hit, query, id, className }: { hit: FileHit; query: string; id: string; className?: string }) {
  return (
    <div id={id} className={cn("grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]", className)}>
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
  );
}

function Preview({ hit, query }: { hit: FileHit; query: string }) {
  const api = useLabApi();
  const frame = "rounded-xl border border-border-opaque bg-background-primary";
  if (hit.hasPreview) {
    return (
      <div className={cn(frame, "flex min-h-40 items-center justify-center overflow-hidden")}>
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
      <div className={cn(frame, "max-h-72 overflow-auto p-4 text-paragraph-small whitespace-pre-wrap text-content-primary")}>
        <Highlighted text={hit.snippet} query={query} />
      </div>
    );
  }
  return (
    <div className={cn(frame, "flex min-h-24 items-center p-4 text-paragraph-small text-content-tertiary")}>
      No preview for this file yet.
    </div>
  );
}
