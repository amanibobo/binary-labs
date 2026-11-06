"use client";
import Link from "next/link";
import { isTextBearing, type FileHit } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { openTarget } from "@/lib/format";
import { newProtocolHref } from "@/lib/protocols";
import { MapIcon, OpenExternalIcon, ProtocolIcon } from "../icons/drawn";
import { fileNodeId, localMapHref } from "@/lib/map";
import { FileCharts, MakeChartLink } from "../charts/file-charts";
import { useLabApi } from "../lab-api";
import { Highlighted } from "../search/highlighted";
import { buttonVariants } from "../ui/button";
import { When } from "@/components/ui/when";

// The opened state of a file row: the preview, then the one obvious action, opening the real
// file. The row above already shows its name and path; duplicates elsewhere are listed under it.
// A file with text can also start a protocol, and a data sheet a chart.
export function PreviewPanel({
  hit,
  query,
  id,
  className,
  offerNewPage = true,
}: {
  hit: FileHit;
  query: string;
  id: string;
  className?: string;
  offerNewPage?: boolean;
}) {
  const [primary, ...others] = hit.locations;
  const open = openTarget(primary);
  const isSheet = hit.fileKind === "spreadsheet";
  const newPage = offerNewPage && isTextBearing(hit.fileKind);
  return (
    <div id={id} className={cn("grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]", className)}>
      <Preview hit={hit} query={query} />
      <div className="flex min-w-0 flex-col items-start gap-5">
        {open === null ? null : (
          <a href={open.href} target="_blank" rel="noreferrer" className={buttonVariants({ size: "compact" })}>
            <OpenExternalIcon className="size-5" />
            {open.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        {others.length === 0 ? null : (
          <div className="w-full min-w-0">
            <h3 className="text-label-medium text-content-primary">Also in</h3>
            <ul className="mt-2 grid gap-3">
              {others.map((location) => {
                const target = openTarget(location);
                return (
                  <li key={location.id} className="min-w-0">
                    {target === null ? (
                      <p className="font-mono text-paragraph-small [overflow-wrap:anywhere] text-content-secondary">{location.path}</p>
                    ) : (
                      <a
                        href={target.href}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-paragraph-small [overflow-wrap:anywhere] text-content-accent underline-offset-2 hover:underline"
                      >
                        {location.path}
                        <span className="sr-only"> ({target.label}, opens in a new tab)</span>
                      </a>
                    )}
                    <p className="mt-0.5 text-paragraph-xsmall text-content-tertiary">
                      Modified <When iso={location.modifiedAt} />
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="flex flex-col items-start gap-1">
          <Link
            href={localMapHref(fileNodeId(hit.sha256))}
            className={cn(buttonVariants({ variant: "tertiary", size: "compact" }), "-ml-3 text-content-secondary")}
          >
            <MapIcon className="size-5" />
            Map around this file
          </Link>
          {isSheet ? <MakeChartLink hit={hit} /> : null}
            {newPage ? (
              <Link
                href={newProtocolHref(hit.sha256)}
                className={cn(buttonVariants({ variant: "tertiary", size: "compact" }), "-ml-3 text-content-secondary")}
              >
                <ProtocolIcon className="size-5" />
                Make a protocol from this file
              </Link>
            ) : null}
        </div>
        {isSheet ? <FileCharts hit={hit} /> : null}
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
