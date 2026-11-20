"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { When } from "@/components/ui/when";
import { fileHistoryHref } from "@/lib/drive";
import { useRunsApi } from "./runs-api";
import type { RunSectionSlot } from "./section";

// Under the run's files: the ones changed in the lab's folder after the run. The run still
// opens the version it was made with; the file's history shows both.
export const OriginalsSection: RunSectionSlot = ({ run }) => {
  const api = useRunsApi();
  const edited = useQuery({
    queryKey: ["run-edited-files", run.id, run.files.map((f) => f.sha256).join(",")],
    queryFn: ({ signal }) => api.editedFiles(run.id, signal),
    staleTime: 60_000,
  });
  const files = edited.data ?? [];
  if (files.length === 0) return null;
  return (
    <ul aria-label="Files changed since this run" className="mt-3 grid gap-2 text-paragraph-small text-content-secondary">
      {files.map((file) => {
        const name = run.files.find((f) => f.sha256 === file.sha256)?.name ?? "A file";
        return (
          <li key={file.sha256} className="max-w-prose">
            <span className="text-content-primary">{name}</span> was changed in the lab&apos;s folder after this run, most recently on <When iso={file.latestAt} />.
            Open original still gives the version from <When iso={file.heldAt} /> that the run was made with.{" "}
            {/* The version after the run's: the history shows each version beside the one before it. */}
            <Link
              href={fileHistoryHref(file.locationId, file.heldVersion + 1)}
              className="text-content-primary underline decoration-content-tertiary underline-offset-4 hover:decoration-content-primary"
            >
              See what changed
            </Link>
          </li>
        );
      })}
    </ul>
  );
};
