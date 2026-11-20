import Link from "next/link";
import { cn } from "@/lib/cn";
import {
  DRIVE_ARRANGEMENTS,
  driveFolderHref,
  driveFolderMeta,
  driveFolderName,
  driveHref,
  sortDriveFolders,
  type DriveBy,
  type DriveFolder,
} from "@/lib/drive";
import { FOLDER_TINTS } from "@/lib/tints";
import { FolderArt } from "../files/folder-art";
import { Breadcrumbs } from "../ui/breadcrumbs";
import { FilesViewSwitch } from "./view-switch";

// The bar every drive page starts with: where you are, and the way back to Dropbox's folders.
export function DriveBar({ crumbs }: { crumbs: readonly { label: string; href: string }[] }) {
  return (
    <div className="border-b border-border-opaque">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Breadcrumbs items={crumbs} />
        <FilesViewSwitch current="drive" className="max-sm:hidden" />
      </div>
    </div>
  );
}

// The arrangement being looked at, so a folder's breadcrumb leads back to it.
export function driveCrumb(labName: string, by: DriveBy): { label: string; href: string } {
  return { label: labName, href: driveHref(by) };
}

// The lab drive's first page: every file under its clean name, in folders made from the
// labels. Nothing here is a real folder, and nothing in Dropbox moves.
export function DriveView({ labName, by, folders }: { labName: string; by: DriveBy; folders: readonly DriveFolder[] }) {
  const sorted = sortDriveFolders(by, folders);
  return (
    <>
      <DriveBar crumbs={[driveCrumb(labName, by)]} />
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-24 sm:px-6 sm:pt-10">
        <h1 className="text-heading-medium">Lab drive</h1>
        <p className="mt-1 max-w-prose text-paragraph-small text-content-tertiary">
          Every file under its clean name, with its older versions. Binary only reads the lab&rsquo;s Dropbox, so nothing there is moved or
          renamed.
        </p>
        <nav aria-label="Arrange by" className="mt-6 flex flex-wrap gap-1 text-label-medium">
          {DRIVE_ARRANGEMENTS.map((a) => (
            <Link
              key={a.by}
              href={driveHref(a.by)}
              aria-current={a.by === by ? "page" : undefined}
              className={cn(
                "rounded-md px-2 py-1 transition-colors duration-150 ease-out",
                a.by === by ? "bg-background-secondary text-content-primary" : "text-content-tertiary hover:text-content-primary",
              )}
            >
              {a.label}
            </Link>
          ))}
        </nav>
        {sorted.length === 0 ? (
          <p className="mt-8 max-w-prose text-paragraph-medium text-content-secondary">
            No files yet. They show up here as Binary reads the lab&rsquo;s folder.
          </p>
        ) : (
          <ul className="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(230px,1fr))] sm:gap-4">
            {sorted.map((folder, i) => (
              <li key={folder.key}>
                <Link
                  href={driveFolderHref(by, folder.key)}
                  className="group flex flex-col items-center rounded-card border border-transparent px-3 pt-4 pb-5 text-center transition-colors duration-150 ease-out hover:border-border-opaque hover:bg-background-raised focus-visible:bg-background-raised sm:px-6 sm:pt-6"
                >
                  <FolderArt
                    tint={folder.key === "" ? { tint: "gray", shade: "soft" } : { tint: FOLDER_TINTS[i % FOLDER_TINTS.length] ?? "gray", shade: "base" }}
                    className="w-full max-w-52 transition-transform duration-200 ease-out group-hover:-translate-y-0.5"
                  />
                  <span className="mt-4 w-full truncate text-label-large text-content-primary">{driveFolderName(by, folder)}</span>
                  <span className="mt-1 text-paragraph-small text-content-tertiary">{driveFolderMeta(folder)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
