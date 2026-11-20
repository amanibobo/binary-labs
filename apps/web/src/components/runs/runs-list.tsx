"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/format";
import { filesCount, RUNS_PAGE, statusLabel, type RunListFilter, type RunRow, type RunSuggestion } from "@/lib/run-record";
import { Button } from "../ui/button";
import { dataRow, dataRowInteractive, dataSurface } from "../ui/data-table";
import { RunFilters } from "./run-filters";
import { runHref, useRunsApi } from "./runs-api";

// The lab's runs, newest first. Above them, once, the files a person already checked that
// could become runs: nothing does until someone taps Make a run.
export function RunsListView({ initial, suggestions, filter }: { initial: RunRow[]; suggestions: RunSuggestion[]; filter: RunListFilter }) {
  const api = useRunsApi();
  const [runs, setRuns] = useState(initial);
  const [more, setMore] = useState(initial.length === RUNS_PAGE);
  const [loading, setLoading] = useState(false);
  const filtered = Object.keys(filter).length > 0;

  const loadMore = async () => {
    setLoading(true);
    try {
      const next = await api.list({ filter, offset: runs.length }, new AbortController().signal);
      setRuns((current) => [...current, ...next]);
      setMore(next.length === RUNS_PAGE);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't load more runs. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-8 pb-24 sm:px-8 sm:pt-16">
      <h1 className="text-heading-medium">Runs</h1>
      <p className="mt-1 max-w-prose text-paragraph-small text-content-secondary">
        A run is one attempt at an experiment: what you tried, when, how it went, and the files it produced.
      </p>
      <Suggestions initial={suggestions} />
      <RunFilters filter={filter} />
      {runs.length === 0 ? (
        <p className="mt-8 max-w-prose text-paragraph-medium text-content-secondary">
          {filtered
            ? "No runs match."
            : "No runs yet. In Search or Browse, choose Select, tick the files from one attempt, then choose Make a run from these files."}
        </p>
      ) : (
        <ul className={cn(dataSurface, "mt-6")}>
          {runs.map((run) => (
            <li key={run.id} className={cn(dataRow, dataRowInteractive)}>
              <Link href={runHref(run.id)} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 px-4 py-3 sm:px-5">
                <span className="min-w-0">
                  <span className="block text-label-medium break-words text-content-primary">{run.title}</span>
                  <span className="block text-paragraph-small text-content-tertiary">
                    {[run.startedOn === null ? null : formatDay(run.startedOn), run.experiment, run.person, filesCount(run.files), run.retryOf === null ? null : `a retry of ${run.retryOf.title}`]
                      .filter((p) => p !== null)
                      .join(" · ")}
                  </span>
                </span>
                <span className={cn("shrink-0 text-label-small", run.status === null ? "text-content-tertiary" : "text-content-primary")}>{statusLabel(run.status)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {more ? (
        <Button type="button" variant="secondary" size="compact" disabled={loading} onClick={() => void loadMore()} className="mt-4">
          {loading ? "Loading" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}

function Suggestions({ initial }: { initial: RunSuggestion[] }) {
  const api = useRunsApi();
  const router = useRouter();
  const [open, setOpen] = useState(initial);
  const [making, setMaking] = useState<string | null>(null);
  if (open.length === 0) return null;

  const make = async (suggestion: RunSuggestion) => {
    setMaking(suggestion.key);
    try {
      const run = await api.create(suggestion.shas, {});
      router.push(runHref(run.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't make that run. Try again.");
      setMaking(null);
    }
  };
  const dismiss = () => {
    setOpen([]);
    api.dismissSuggestions().catch(() => toast.error("We couldn't put the list away. It will be back next time."));
  };

  return (
    <section aria-labelledby="run-suggestions" className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 id="run-suggestions" className="text-label-large text-content-primary">
          Turn these into runs?
        </h2>
        <button type="button" onClick={dismiss} className="rounded-md px-1.5 text-label-small text-content-tertiary hover:text-content-primary">
          Don&rsquo;t show this again
        </button>
      </div>
      <p className="mt-1 max-w-prose text-paragraph-small text-content-tertiary">
        Files whose labels someone in the lab has already checked, and that say how they went. Nothing becomes a run until you choose it.
      </p>
      <ul className={cn(dataSurface, "mt-3")}>
        {open.map((s) => (
          <li key={s.key} className={cn(dataRow, "flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-5")}>
            <span className="min-w-0">
              <span className="block text-label-medium break-words text-content-primary">{s.title}</span>
              <span className="block text-paragraph-small text-content-tertiary">
                {[s.date === null ? null : formatDay(s.date), filesCount(s.shas.length), `its label says ${s.fileSays === "repeat" ? "a repeat" : s.fileSays}`].filter((p) => p !== null).join(" · ")}
              </span>
            </span>
            <Button type="button" variant="secondary" size="compact" disabled={making !== null} onClick={() => void make(s)}>
              {making === s.key ? "Making the run" : "Make a run"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
