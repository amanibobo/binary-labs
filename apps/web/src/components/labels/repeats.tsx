"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import type { FileRef, Label } from "@/lib/domain";
import { formatDay } from "@/lib/format";
import { useLabApi } from "../lab-api";
import { DeleteIcon } from "../icons/base-web";
import { useLabels, type LabeledFile } from "./labels-context";

// Where a linked run opens: Search, with its name typed and its row open.
export function runHref(run: FileRef): string {
  return `/?${new URLSearchParams({ q: run.name, open: run.sha256 })}`;
}

function RunLink({ run }: { run: FileRef }) {
  return (
    <Link href={runHref(run)} className="text-content-primary underline decoration-content-tertiary underline-offset-4 hover:decoration-content-primary">
      {run.name}
    </Link>
  );
}

// The repeat links at rest: the run this one repeats, the repeats of it, and for a run marked
// "A repeat" with no link yet, one question with the way to answer it.
export function RepeatLines({ hit, label }: { hit: LabeledFile; label: Label }) {
  const asking = label.outcome === "repeat" && label.repeatOf === null;
  if (label.repeatOf === null && label.repeatedIn.length === 0 && !asking) return null;
  return (
    <div className="grid gap-1 text-paragraph-small text-content-secondary">
      {label.repeatOf === null ? null : (
        <p>
          A repeat of <RunLink run={label.repeatOf} />
        </p>
      )}
      {label.repeatedIn.length === 0 ? null : (
        <p>
          Repeated in{" "}
          {label.repeatedIn.map((run, i) => (
            <span key={run.sha256}>
              {i > 0 ? ", " : null}
              <RunLink run={run} />
            </span>
          ))}
        </p>
      )}
      {asking ? (
        <div className="flex flex-wrap items-center gap-x-2">
          <span className="text-content-primary">Which run does this repeat?</span>
          <RepeatPicker hit={hit} trigger="Pick the run" />
        </div>
      ) : null}
    </div>
  );
}

// The Repeat of line under Edit labels: the linked run with a way to take the link off, or the
// picker.
export function RepeatField({ hit, label }: { hit: LabeledFile; label: Label }) {
  const labels = useLabels();
  if (label.repeatOf === null) return <RepeatPicker hit={hit} trigger="Pick the run" />;
  return (
    <span className="flex min-h-7 items-center gap-1.5 py-0.5 text-paragraph-small max-sm:min-h-11">
      <RunLink run={label.repeatOf} />
      <button
        type="button"
        onClick={() => labels.linkRepeat(hit, null)}
        className="inline-flex size-7 items-center justify-center rounded-md text-content-tertiary hover:bg-background-tertiary hover:text-content-primary max-sm:size-11"
      >
        <DeleteIcon className="size-4" />
        <span className="sr-only">Remove the link to {label.repeatOf.name}</span>
      </button>
      <RepeatPicker hit={hit} trigger="Change" />
    </span>
  );
}

// Type to find the run; the same experiment's runs on the nearest days come first. A tap links.
function RepeatPicker({ hit, trigger }: { hit: LabeledFile; trigger: string }) {
  const api = useLabApi();
  const labels = useLabels();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputId = useId();
  const listId = useId();
  const candidates = useQuery({
    queryKey: ["repeat-candidates", hit.sha256, query.trim()],
    queryFn: ({ signal }) => api.repeatCandidates(hit.sha256, query.trim(), signal),
    enabled: open,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="-mx-1.5 inline-flex min-h-7 items-center rounded-md px-1.5 text-label-small text-content-primary transition-colors duration-150 ease-out hover:bg-background-tertiary max-sm:min-h-11"
      >
        {trigger}
      </button>
    );
  }
  const runs = candidates.data ?? [];
  return (
    <div
      className="mt-1 grid w-full max-w-96 gap-1"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Find the run this repeats
      </label>
      <input
        id={inputId}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find the run by name"
        aria-controls={listId}
        className="h-8 w-full rounded-md border border-border-opaque bg-background-primary px-2 text-paragraph-small text-content-primary max-sm:h-11 max-sm:text-paragraph-medium"
      />
      <ul id={listId} aria-label="Runs" aria-busy={candidates.isFetching} className="grid">
        {runs.map((run) => (
          <li key={run.sha256}>
            <button
              type="button"
              onClick={() => {
                labels.linkRepeat(hit, { sha256: run.sha256, name: run.name });
                setOpen(false);
              }}
              className="flex min-h-8 w-full min-w-0 items-baseline gap-2 rounded-md px-2 text-left text-paragraph-small hover:bg-background-tertiary max-sm:min-h-11"
            >
              <span className="truncate text-content-primary">{run.name}</span>
              <span className="shrink-0 text-paragraph-xsmall text-content-tertiary">
                {[run.date === null ? null : formatDay(run.date), run.experiment].filter((p) => p !== null).join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {candidates.isSuccess && runs.length === 0 ? <p className="px-2 text-paragraph-small text-content-tertiary">No runs match.</p> : null}
      {candidates.isError ? <p className="px-2 text-paragraph-small text-content-primary">We couldn&apos;t list the runs. Try again.</p> : null}
      <button type="button" onClick={() => setOpen(false)} className="justify-self-start rounded-md px-2 text-label-small text-content-tertiary hover:text-content-primary">
        Cancel
      </button>
    </div>
  );
}
