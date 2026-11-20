"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import type { Sha256 } from "@/lib/ids";
import { MAX_RUN_FILES, statusLabel } from "@/lib/run-record";
import { buttonVariants } from "../ui/button";
import { runHref, useRunsApi } from "./runs-api";

function useMakeRun() {
  const api = useRunsApi();
  const router = useRouter();
  const queries = useQueryClient();
  const [making, setMaking] = useState(false);
  const make = async (shas: readonly Sha256[]) => {
    setMaking(true);
    try {
      const run = await api.create(shas, {});
      await queries.invalidateQueries({ queryKey: ["file-run"] });
      router.push(runHref(run.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't make that run. Try again.");
      setMaking(false);
    }
  };
  return { making, make };
}

// In the bar under a list while rows are picked: the picked files become one run, named and
// dated from the first one, and its page opens.
export function MakeRunFromPicked({ shas }: { shas: readonly Sha256[] }) {
  const { making, make } = useMakeRun();
  if (shas.length === 0) return null;
  const tooMany = shas.length > MAX_RUN_FILES;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-opaque pt-3">
      <button type="button" disabled={making || tooMany} onClick={() => void make(shas)} className={buttonVariants({ variant: "secondary", size: "compact" })}>
        {making ? "Making the run" : shas.length === 1 ? "Make a run from this file" : `Make a run from these ${shas.length} files`}
      </button>
      {tooMany ? (
        <span className="text-paragraph-small text-content-secondary">A run takes up to {MAX_RUN_FILES} files at a time.</span>
      ) : (
        <span className="text-paragraph-small text-content-tertiary max-sm:hidden">A run is one attempt at an experiment. You can say how it went on the next page.</span>
      )}
    </div>
  );
}

// On an opened file: the run it belongs to, or the way to make one from it.
export function FileRunLine({ sha256 }: { sha256: Sha256 }) {
  const api = useRunsApi();
  const { making, make } = useMakeRun();
  const found = useQuery({
    queryKey: ["file-run", sha256],
    queryFn: async ({ signal }) => (await api.fileRuns([sha256], signal))[0] ?? null,
    staleTime: 30_000,
  });
  if (!found.isSuccess) return null;
  if (found.data === null) {
    return (
      <button
        type="button"
        disabled={making}
        onClick={() => void make([sha256])}
        className="-mx-1.5 inline-flex min-h-7 items-center justify-self-start rounded-md px-1.5 text-label-small text-content-primary transition-colors duration-150 ease-out hover:bg-background-tertiary max-sm:min-h-11"
      >
        {making ? "Making the run" : "Make a run from this file"}
      </button>
    );
  }
  return (
    <p className="text-paragraph-small text-content-secondary">
      Part of the run{" "}
      <Link href={runHref(found.data.runId)} className="text-content-primary underline decoration-content-tertiary underline-offset-4 hover:decoration-content-primary">
        {found.data.title}
      </Link>
      <span className="text-content-tertiary"> ({statusLabel(found.data.status).toLowerCase()})</span>
    </p>
  );
}
