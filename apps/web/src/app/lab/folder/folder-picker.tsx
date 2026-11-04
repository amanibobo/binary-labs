"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronRightIcon } from "@/components/icons/base-web";
import { FolderFilledIcon } from "@/components/icons/drawn";
import { dataSurface } from "@/components/ui/data-table";
import { cn } from "@/lib/cn";
import { useLabApi } from "@/components/lab-api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { setFolder } from "../actions";

function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return [{ name: "Dropbox", path: "" }, ...parts.map((name, i) => ({ name, path: `/${parts.slice(0, i + 1).join("/")}` }))];
}

export function FolderPicker({ initialPath = "" }: { initialPath?: string }) {
  const api = useLabApi();
  const [path, setPath] = useState(initialPath);
  const [saving, startSaving] = useTransition();
  const { data, isError, refetch } = useQuery({
    queryKey: ["dropbox-folders", path],
    queryFn: ({ signal }) => api.folders(path, signal),
  });
  const trail = crumbs(path);

  return (
    <div className={cn(dataSurface, "rounded-card")}>
      <nav aria-label="Folder path" className="border-b border-border-opaque px-5 py-3">
        <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 font-mono text-paragraph-small">
          {trail.map((crumb, i) => (
            <li key={crumb.path} className="flex items-center gap-1">
              {i > 0 ? <span className="text-content-tertiary">/</span> : null}
              {i === trail.length - 1 ? (
                <span aria-current="location" className="px-1 text-content-primary">
                  {crumb.name}
                </span>
              ) : (
                <button type="button" onClick={() => setPath(crumb.path)} className="min-h-11 rounded px-1 text-content-accent underline-offset-2 hover:underline sm:min-h-8">
                  {crumb.name}
                </button>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="max-h-[50vh] overflow-y-auto py-1" aria-live="polite">
        {data === undefined ? (
          isError ? (
            <div className="p-4">
              <p className="text-paragraph-medium text-content-primary">We couldn&apos;t list this folder.</p>
              <Button variant="secondary" className="mt-3" onClick={() => void refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="grid gap-1 p-2" aria-hidden>
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )
        ) : data.folders.length === 0 ? (
          <p className="p-4 text-paragraph-medium text-content-tertiary">No folders inside this one.</p>
        ) : (
          <ul className="divide-y divide-border-opaque">
            {data.folders.map((folder) => (
              <li key={folder.path}>
                <button
                  type="button"
                  onClick={() => setPath(folder.path)}
                  className="flex min-h-12 w-full items-center text-left transition-colors duration-150 ease-out hover:bg-background-secondary focus-visible:outline-offset-[-2px]"
                >
                  <span className="flex w-14 shrink-0 justify-center">
                    <FolderFilledIcon className="size-5 text-tint-gray" />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-label-small text-content-primary">{folder.name}</span>
                  <span className="sr-only">, open folder</span>
                  <ChevronRightIcon className="mr-4 text-content-tertiary" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-border-opaque px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-paragraph-small text-content-tertiary">
          {path === "" ? (
            "Open the folder your lab keeps its work in."
          ) : (
            <>
              Index <span className="font-mono text-paragraph-small break-all text-content-primary">{path}</span> and everything inside it.
            </>
          )}
        </p>
        <Button
          className="w-full sm:w-auto"
          disabled={path === "" || saving}
          onClick={() =>
            startSaving(async () => {
              const result = await setFolder(path);
              if (result.kind === "error") toast.error(result.message);
            })
          }
        >
          {saving ? "Saving folder" : "Use this folder"}
        </Button>
      </div>
    </div>
  );
}
