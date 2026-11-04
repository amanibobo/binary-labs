"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import Link from "next/link";
import { useId, useState } from "react";
import type { FileHit } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { folderAncestors, folderHref, folderName, type FolderNode } from "@/lib/folders";
import { countLine, formatDate, formatSize, KIND_LABELS, openInDropboxUrl } from "@/lib/format";
import type { SourceState } from "@/lib/source-state";
import { OpenExternalIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { ActiveScan } from "../scan-status";
import { Breadcrumbs } from "../ui/breadcrumbs";
import { Button, buttonVariants } from "../ui/button";
import { DataCell, DataHeaderCell, DataTable, dataRow, dataRowInteractive } from "../ui/data-table";
import { FolderArt } from "./folder-art";
import { KindIcon } from "./kind-icon";
import { PreviewPanel } from "./preview-panel";

export function BrowseView({
  labName,
  folder,
  initialFiles,
  source,
  isAdmin,
}: {
  labName: string;
  folder: FolderNode;
  initialFiles: FileHit[];
  source: SourceState;
  isAdmin: boolean;
}) {
  const crumbs = folderAncestors(folder.path).map((path) => ({ label: path === "" ? labName : folderName(path), href: folderHref(path) }));
  const filesId = useId();
  return (
    <>
      <div className="border-b border-border-opaque">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center px-4 sm:px-6">
          <Breadcrumbs items={crumbs} />
        </div>
      </div>
      <h1 className="sr-only">{folder.path === "" ? labName : folder.name}</h1>
      <div className="mx-auto w-full max-w-[1240px] px-4 pt-8 pb-24 sm:px-8 sm:pt-10">
        <ActiveScan initial={source} />
        {folder.path === "" && folder.totalFiles === 0 ? (
          <EmptyLab source={source} isAdmin={isAdmin} />
        ) : (
          <>
            {folder.children.length > 0 ? (
              <section aria-labelledby={`${filesId}-folders`} className="mb-12">
                <h2 id={`${filesId}-folders`} className="mb-5 text-heading-medium">
                  Folders
                </h2>
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(230px,1fr))] sm:gap-4">
                  {folder.children.map((child) => (
                    <li key={child.path}>
                      <FolderCard folder={child} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section aria-labelledby={`${filesId}-files`}>
              <h2 id={`${filesId}-files`} className="mb-5 text-heading-medium">
                Files
              </h2>
              <FilesTable folder={folder} initialFiles={initialFiles} />
            </section>
          </>
        )}
      </div>
    </>
  );
}

function FolderCard({ folder }: { folder: FolderNode }) {
  const meta = [countLine(folder.totalFiles, "file", "files")];
  if (folder.children.length > 0) meta.push(countLine(folder.children.length, "subfolder", "subfolders"));
  return (
    <Link
      href={folderHref(folder.path)}
      className="group flex flex-col items-center rounded-card border border-transparent px-3 pt-4 pb-5 text-center transition-colors duration-150 ease-out hover:border-border-opaque hover:bg-background-raised focus-visible:bg-background-raised sm:px-6 sm:pt-6"
    >
      <FolderArt tint={folder.tint} className="w-full max-w-52 transition-transform duration-200 ease-out group-hover:-translate-y-0.5" />
      <span className="mt-4 w-full truncate text-label-large text-content-primary">{folder.name}</span>
      <span className="mt-1 text-paragraph-small text-content-tertiary">{meta.join(" · ")}</span>
    </Link>
  );
}

function FilesTable({ folder, initialFiles }: { folder: FolderNode; initialFiles: FileHit[] }) {
  const api = useLabApi();
  const [expanded, setExpanded] = useState<string | null>(null);
  const files = useInfiniteQuery({
    queryKey: ["folder-files", folder.path],
    queryFn: ({ pageParam, signal }) => api.folderFiles(folder.path, pageParam, signal),
    initialPageParam: 0,
    initialData: { pages: [initialFiles], pageParams: [0] },
    getNextPageParam: (_last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.length, 0);
      return loaded < folder.directFiles ? loaded : undefined;
    },
    staleTime: 60_000,
  });
  const rows = files.data.pages.flat();

  if (rows.length === 0) {
    return (
      <p className="text-paragraph-medium text-content-tertiary">
        {folder.children.length > 0 ? "No files directly in this folder. Open a folder above." : "No files in this folder."}
      </p>
    );
  }
  return (
    <>
      <DataTable aria-label="Files">
        <colgroup>
          <col />
          <col className="w-36 max-md:w-0" />
          <col className="w-36 max-sm:w-0" />
          <col className="w-24 max-md:w-0" />
          <col className="w-14" />
        </colgroup>
        <thead className="border-b border-border-opaque">
          <tr>
            <DataHeaderCell>Name</DataHeaderCell>
            <DataHeaderCell className="max-md:hidden">Kind</DataHeaderCell>
            <DataHeaderCell className="max-sm:hidden">Modified</DataHeaderCell>
            <DataHeaderCell className="text-right max-md:hidden">Size</DataHeaderCell>
            <DataHeaderCell>
              <span className="sr-only">Actions</span>
            </DataHeaderCell>
          </tr>
        </thead>
        <tbody>
          {rows.map((hit) => (
            <FileRow
              key={hit.locations[0].id}
              hit={hit}
              expanded={expanded === hit.locations[0].id}
              onToggle={() => setExpanded((cur) => (cur === hit.locations[0].id ? null : hit.locations[0].id))}
            />
          ))}
        </tbody>
      </DataTable>
      {files.hasNextPage ? (
        <Button variant="secondary" className="mt-4" disabled={files.isFetchingNextPage} onClick={() => void files.fetchNextPage()}>
          {files.isFetchingNextPage ? "Loading more files" : `Show more files (${rows.length} of ${folder.directFiles})`}
        </Button>
      ) : null}
    </>
  );
}

function FileRow({ hit, expanded, onToggle }: { hit: FileHit; expanded: boolean; onToggle: () => void }) {
  const panelId = useId();
  const location = hit.locations[0];
  return (
    <>
      <tr className={cn(dataRow, dataRowInteractive, "group")}>
        <DataCell className="py-0">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={onToggle}
            className="flex min-h-14 w-full min-w-0 items-center gap-3 text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-border-accent"
          >
            <KindIcon kind={hit.fileKind} className="size-5" />
            <span className="min-w-0">
              <span className="block truncate font-mono text-label-small text-content-primary">{location.originalName}</span>
              <span className="mt-0.5 block text-paragraph-xsmall text-content-tertiary sm:hidden">
                {KIND_LABELS[hit.fileKind]} · {formatDate(location.modifiedAt)}
              </span>
            </span>
          </button>
        </DataCell>
        <DataCell className="text-paragraph-small text-content-secondary max-md:hidden">{KIND_LABELS[hit.fileKind]}</DataCell>
        <DataCell className="text-paragraph-small text-content-secondary tabular-nums max-sm:hidden">{formatDate(location.modifiedAt)}</DataCell>
        <DataCell className="text-right text-paragraph-small text-content-secondary tabular-nums max-md:hidden">{formatSize(hit.size)}</DataCell>
        <DataCell className="py-0 pr-2 sm:pr-3">
          {location.sourceKind === "dropbox" ? (
            <a
              href={openInDropboxUrl(location.path)}
              target="_blank"
              rel="noreferrer"
              className={cn(
                buttonVariants({ variant: "tertiary", shape: "square", size: "compact" }),
                "relative z-10 text-content-secondary opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100",
              )}
            >
              <OpenExternalIcon className="size-5" />
              <span className="sr-only">Open {location.originalName} in Dropbox (opens in a new tab)</span>
            </a>
          ) : null}
        </DataCell>
      </tr>
      {expanded ? (
        <tr className="bg-background-secondary">
          <td colSpan={5} className="p-0">
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} className="overflow-hidden">
              <PreviewPanel id={panelId} hit={hit} query="" className="px-4 pt-2 pb-6 sm:pr-5 sm:pl-13" />
            </motion.div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function EmptyLab({ source, isAdmin }: { source: SourceState; isAdmin: boolean }) {
  const message =
    source.kind === "connected"
      ? "Folders show up here as files are indexed."
      : isAdmin
        ? "Connect your lab's Dropbox and pick a folder to start."
        : "Your lab hasn't picked a Dropbox folder yet. An admin can do it from Settings.";
  return (
    <div>
      <p className="max-w-prose text-paragraph-medium text-content-secondary">{message}</p>
      {source.kind !== "connected" && isAdmin ? (
        <Link href="/lab" className={cn(buttonVariants(), "mt-4")}>
          Open settings
        </Link>
      ) : null}
    </div>
  );
}
