"use client";
import Link from "next/link";
import { When } from "@/components/ui/when";
import { cn } from "@/lib/cn";
import {
  changeLine,
  fileHistoryHref,
  fileTitle,
  versionFileHref,
  versionSource,
  versionsLine,
  type FileVersion,
  type VersionDetail,
} from "@/lib/drive";
import { formatSize, openInDropboxUrl } from "@/lib/format";
import type { LocationId } from "@/lib/ids";
import { diffRows } from "@/lib/text-diff";
import { OpenExternalIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { buttonVariants } from "../ui/button";
import { dataRow, dataSurface } from "../ui/data-table";
import { DriveBar } from "./drive-view";

// A first version with a long text shows its start; the file itself has the rest.
const FIRST_VERSION_LINES = 40;

// One file and every version of it. The newest is shown unless an older one is picked;
// each version says what it changed from the one before, and opens as it was.
export function FileHistoryView({
  crumbs,
  location,
  details,
  shown,
}: {
  crumbs: readonly { label: string; href: string }[];
  location: LocationId;
  // Oldest first, never empty.
  details: readonly VersionDetail[];
  // The number of the version on screen.
  shown: number;
}) {
  const newest = details[details.length - 1]?.version;
  const detail = details.find((d) => d.version.number === shown);
  if (newest === undefined || detail === undefined) return null;
  const { version } = detail;
  const before = details.find((d) => d.version.number === shown - 1)?.version;
  const isNewest = version.number === newest.number;
  const title = fileTitle(newest.label, newest.originalName);
  // The file where it lives now; Dropbox opens it with its own tools.
  const live = newest.sourceKind === "dropbox" ? { href: openInDropboxUrl(newest.path), label: "Open in Dropbox" } : null;
  const cut = newest.path.lastIndexOf("/");
  const folder = cut <= 0 ? "/" : newest.path.slice(0, cut);
  const asItWas = versionFileHref(version);
  return (
    <>
      <DriveBar crumbs={[...crumbs, { label: title, href: fileHistoryHref(location) }]} />
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-24 sm:px-6 sm:pt-10">
        <h1 className="text-heading-medium">{title}</h1>
        <p className="mt-1 text-paragraph-small text-content-tertiary">
          <span className="font-mono">{newest.originalName}</span> in {folder} · {versionsLine(details.length)}
        </p>

        {isNewest ? null : (
          <p role="status" className="mt-6 rounded-card border border-border-opaque bg-background-secondary px-4 py-3 text-paragraph-small text-content-primary">
            This is version {version.number} of {details.length}, as it was on <When iso={version.modifiedAt} />. It isn&rsquo;t the newest.{" "}
            <Link href={fileHistoryHref(location)} className="text-content-accent underline-offset-2 hover:underline">
              Go to the newest version
            </Link>
          </p>
        )}

        <div className="mt-8 grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <section aria-labelledby="version-heading" className="min-w-0">
            <h2 id="version-heading" className="text-label-large text-content-primary">
              Version {version.number}
              {isNewest ? <span className="text-content-tertiary"> · newest</span> : null}
            </h2>
            <p className="mt-1 text-paragraph-small text-content-tertiary">
              Saved <When iso={version.modifiedAt} />
              {versionSource(version) === null ? null : <>, {versionSource(version)}</>} · {formatSize(version.size)}
              {version.originalName === newest.originalName ? null : (
                <>
                  {" "}
                  · named <span className="font-mono">{version.originalName}</span> then
                </>
              )}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {asItWas === null ? null : (
                <a href={asItWas} target="_blank" rel="noreferrer" className={buttonVariants({ size: "compact" })}>
                  <OpenExternalIcon className="size-5" />
                  {isNewest ? "Open the file" : "Open this version"}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              )}
              {isNewest && live !== null ? (
                <a href={live.href} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "compact" })}>
                  {live.label}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : null}
            </div>
            {asItWas === null ? (
              <p className="mt-3 max-w-prose text-paragraph-small text-content-secondary">
                Binary read this version before it started keeping every file, and the file has changed since, so it has this version&rsquo;s
                preview and text but not the file itself.
              </p>
            ) : null}

            <Pictures version={version} before={before} />
            <Changes detail={detail} />
          </section>

          <section aria-labelledby="all-versions-heading" className="min-w-0 max-lg:-order-1">
            <h2 id="all-versions-heading" className="text-label-large text-content-primary">
              All versions
            </h2>
            <ol className={cn(dataSurface, "mt-3")}>
              {[...details].reverse().map(({ version: v, change }) => {
                const current = v.number === version.number;
                return (
                  <li key={v.id} className={cn(dataRow, current ? "bg-background-secondary" : "hover:bg-background-secondary")}>
                    <Link
                      href={fileHistoryHref(location, v.number === newest.number ? null : v.number)}
                      aria-current={current ? "true" : undefined}
                      className="block px-4 py-3"
                    >
                      <span className="block text-label-medium text-content-primary">
                        Version {v.number}
                        {v.number === newest.number ? <span className="text-content-tertiary"> · newest</span> : null}
                      </span>
                      <span className="mt-0.5 block text-paragraph-small text-content-tertiary">
                        <When iso={v.modifiedAt} />
                        {versionSource(v) === null ? null : <>, {versionSource(v)}</>}
                      </span>
                      <span className="mt-0.5 block text-paragraph-small text-content-secondary">{changeLine(change)}</span>
                    </Link>
                  </li>
                );
              })}
            </ol>
            <p className="mt-3 text-paragraph-xsmall text-content-tertiary">
              A version is the file as Binary found it each time it changed. Binary keeps its own copy of each one and never changes the
              lab&rsquo;s files.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

// The version's preview, beside the one before it when the file has no text to compare.
function Pictures({ version, before }: { version: FileVersion; before: FileVersion | undefined }) {
  const api = useLabApi();
  if (!version.hasPreview) return null;
  const pair = before !== undefined && before.hasPreview && version.fileKind === "image";
  return (
    <div className={cn("mt-6 grid gap-4", pair ? "sm:grid-cols-2" : "max-w-md")}>
      {pair ? <Picture src={api.previewUrl(before.sha256, { view: false })} caption={`Version ${before.number}, before`} /> : null}
      <Picture src={api.previewUrl(version.sha256, { view: true })} caption={pair ? `Version ${version.number}` : null} />
    </div>
  );
}

function Picture({ src, caption }: { src: string; caption: string | null }) {
  return (
    <figure className="min-w-0">
      {/* eslint-disable-next-line @next/next/no-img-element -- previews come from our own route, already sized */}
      <img src={src} alt="" className="max-h-96 w-full rounded-control border border-border-opaque bg-background-secondary object-contain" />
      {caption === null ? null : <figcaption className="mt-1.5 text-paragraph-xsmall text-content-tertiary">{caption}</figcaption>}
    </figure>
  );
}

function Changes({ detail: { version, change, lines } }: { detail: VersionDetail }) {
  if (lines === null) {
    return change.kind === "first" ? null : (
      <p className="mt-6 text-paragraph-small text-content-secondary">
        {changeLine(change)}. Binary can&rsquo;t show this change line by line; open both versions to compare them.
      </p>
    );
  }
  if (change.kind === "first") {
    const head = lines.slice(0, FIRST_VERSION_LINES);
    return (
      <div className="mt-6">
        <h3 className="text-label-medium text-content-primary">What it says</h3>
        <pre className="mt-2 overflow-x-auto rounded-control border border-border-opaque bg-background-raised p-3 font-mono text-paragraph-xsmall whitespace-pre-wrap text-content-secondary">
          {head.map((l) => l.text).join("\n")}
        </pre>
        {lines.length > head.length ? (
          <p className="mt-1.5 text-paragraph-xsmall text-content-tertiary">The first {head.length} lines of {lines.length}.</p>
        ) : null}
      </div>
    );
  }
  const rows = diffRows(lines);
  return (
    <div className="mt-6">
      <h3 className="text-label-medium text-content-primary">What changed from version {version.number - 1}</h3>
      <p className="mt-1 text-paragraph-small text-content-secondary">{changeLine(change)}</p>
      {rows.length === 0 ? null : (
        <ol className="mt-3 overflow-x-auto rounded-control border border-border-opaque bg-background-raised py-1 font-mono text-paragraph-xsmall">
          {rows.map((row, i) =>
            row.kind === "gap" ? (
              <li key={i} className="px-3 py-1 font-sans text-content-tertiary">
                {row.count === 1 ? "1 line the same" : `${row.count} lines the same`}
              </li>
            ) : (
              <li
                key={i}
                className={cn(
                  "flex gap-2 px-3 py-0.5 whitespace-pre-wrap",
                  row.kind === "added" && "bg-tint-green-wash text-tint-green-ink",
                  row.kind === "removed" && "bg-background-secondary text-content-tertiary line-through",
                  row.kind === "same" && "text-content-secondary",
                )}
              >
                <span aria-hidden className="w-3 shrink-0 select-none no-underline">
                  {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""}
                </span>
                <span className="sr-only">{row.kind === "added" ? "Added: " : row.kind === "removed" ? "Removed: " : ""}</span>
                <span className="min-w-0">{row.text}</span>
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}
