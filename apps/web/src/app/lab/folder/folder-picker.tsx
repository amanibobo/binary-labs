"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, useTransition } from "react";
import { toast } from "sonner";
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
    <div className="rounded-panel border border-hairline bg-surface">
      <nav aria-label="Folder path" className="border-b border-hairline px-4 py-3">
        <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 font-mono text-[13px]">
          {trail.map((crumb, i) => (
            <li key={crumb.path} className="flex items-center gap-1">
              {i > 0 ? <span className="text-muted">/</span> : null}
              {i === trail.length - 1 ? (
                <span aria-current="location" className="px-1 text-ink">
                  {crumb.name}
                </span>
              ) : (
                <button type="button" onClick={() => setPath(crumb.path)} className="min-h-11 rounded px-1 text-green hover:underline">
                  {crumb.name}
                </button>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="max-h-[50vh] overflow-y-auto p-1" aria-live="polite">
        {data === undefined ? (
          isError ? (
            <div className="p-4">
              <p className="text-[15px] text-ink">We couldn&apos;t list this folder.</p>
              <Button variant="secondary" className="mt-3" onClick={() => void refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="grid gap-1 p-2" aria-hidden>
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          )
        ) : data.folders.length === 0 ? (
          <p className="p-4 text-[15px] text-muted">No folders inside this one.</p>
        ) : (
          <ul>
            {data.folders.map((folder) => (
              <li key={folder.path}>
                <button
                  type="button"
                  onClick={() => setPath(folder.path)}
                  className="flex min-h-11 w-full items-center rounded-control px-3 text-left font-mono text-[13.5px] text-ink transition-colors duration-150 ease-out hover:bg-fill"
                >
                  <span className="truncate">{folder.name}</span>
                  <span className="sr-only">, open folder</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-hairline px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-sm text-muted">
          {path === "" ? (
            "Open the folder your lab keeps its work in."
          ) : (
            <>
              Index <span className="font-mono text-[13px] break-all text-ink">{path}</span> and everything inside it.
            </>
          )}
        </p>
        <Button
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
