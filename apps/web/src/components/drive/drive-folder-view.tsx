"use client";
import { motion } from "motion/react";
import Link from "next/link";
import { useId, useState } from "react";
import { When } from "@/components/ui/when";
import { cn } from "@/lib/cn";
import { DRIVE_PAGE_SIZE, driveFolderHref, fileHistoryHref, fileTitle, versionsLine, type DriveBy, type DriveFile, type DriveKey } from "@/lib/drive";
import { formatSize, KIND_LABELS } from "@/lib/format";
import { KindIcon } from "../files/kind-icon";
import { PreviewPanel } from "../files/preview-panel";
import { FlagMark } from "../flags/flag-marks";
import { buttonVariants } from "../ui/button";
import { DataCell, DataHeaderCell, DataTable, dataRow, dataRowInteractive } from "../ui/data-table";
import { DriveBar } from "./drive-view";

// One folder of the lab drive. A row opens the same preview Browse and Search open; its
// versions link goes to the file's history.
export function DriveFolderView({
  crumbs,
  name,
  by,
  folderKey,
  files,
  from,
  total,
}: {
  crumbs: readonly { label: string; href: string }[];
  name: string;
  by: DriveBy;
  folderKey: DriveKey;
  files: readonly DriveFile[];
  // The files before these, when the folder has more than one page.
  from: number;
  total: number;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const shownTo = from + files.length;
  return (
    <>
      <DriveBar crumbs={crumbs} />
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-24 sm:px-6 sm:pt-10">
        <h1 className="mb-5 text-heading-medium">{name}</h1>
        {files.length === 0 ? (
          <p className="text-paragraph-medium text-content-tertiary">No files here.</p>
        ) : (
          <DataTable aria-label={`Files in ${name}`}>
            <colgroup>
              <col />
              <col className="w-32" />
              <col className="w-36 max-sm:w-0" />
              <col className="w-24 max-md:w-0" />
            </colgroup>
            <thead className="border-b border-border-opaque">
              <tr>
                <DataHeaderCell>Name</DataHeaderCell>
                <DataHeaderCell>Versions</DataHeaderCell>
                <DataHeaderCell className="max-sm:hidden">Last changed</DataHeaderCell>
                <DataHeaderCell className="text-right max-md:hidden">Size</DataHeaderCell>
              </tr>
            </thead>
            <tbody>
              {files.map((file) => {
                const id = file.hit.locations[0].id;
                return <FileRow key={id} file={file} expanded={expanded === id} onToggle={() => setExpanded((cur) => (cur === id ? null : id))} />;
              })}
            </tbody>
          </DataTable>
        )}
        {total > DRIVE_PAGE_SIZE ? (
          <nav aria-label="More files" className="mt-4 flex items-center gap-3 text-paragraph-small text-content-tertiary">
            <span>
              {from + 1} to {shownTo} of {total}
            </span>
            {from > 0 ? (
              <Link href={driveFolderHref(by, folderKey, Math.max(0, from - DRIVE_PAGE_SIZE))} className={buttonVariants({ variant: "secondary", size: "compact" })}>
                Earlier files
              </Link>
            ) : null}
            {shownTo < total ? (
              <Link href={driveFolderHref(by, folderKey, shownTo)} className={buttonVariants({ variant: "secondary", size: "compact" })}>
                More files
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </>
  );
}

function FileRow({ file: { hit, versions }, expanded, onToggle }: { file: DriveFile; expanded: boolean; onToggle: () => void }) {
  const panelId = useId();
  const location = hit.locations[0];
  const title = fileTitle(hit.label, location.originalName);
  return (
    <>
      <tr className={cn(dataRow, dataRowInteractive)}>
        <DataCell className="py-0">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={onToggle}
            className="flex min-h-14 w-full min-w-0 items-center gap-3 py-2 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-border-accent"
          >
            <KindIcon kind={hit.fileKind} className="size-5" />
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-label-medium text-content-primary">{title}</span>
                <FlagMark sha={hit.sha256} className="shrink-0 max-sm:h-6" />
              </span>
              <span className="mt-0.5 block truncate text-paragraph-xsmall text-content-tertiary">
                {title === location.originalName ? KIND_LABELS[hit.fileKind] : <span className="font-mono">{location.originalName}</span>}
              </span>
            </span>
          </button>
        </DataCell>
        <DataCell className="py-0">
          <Link
            href={fileHistoryHref(location.id)}
            className="relative z-10 text-paragraph-small text-content-secondary tabular-nums underline decoration-content-tertiary decoration-dotted underline-offset-4 hover:text-content-primary"
          >
            {versionsLine(versions)}
            <span className="sr-only"> of {title}</span>
          </Link>
        </DataCell>
        <DataCell className="text-paragraph-small text-content-secondary tabular-nums max-sm:hidden">
          <When iso={location.modifiedAt} />
        </DataCell>
        <DataCell className="text-right text-paragraph-small text-content-secondary tabular-nums max-md:hidden">{formatSize(hit.size)}</DataCell>
      </tr>
      {expanded ? (
        <tr className="bg-background-secondary">
          <td colSpan={4} className="p-0">
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} className="overflow-hidden">
              <PreviewPanel id={panelId} hit={hit} query="" className="px-4 pt-2 pb-6 sm:pr-5 sm:pl-13" />
            </motion.div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
