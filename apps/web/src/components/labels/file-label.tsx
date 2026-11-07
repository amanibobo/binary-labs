
"use client";

import type { FileHit, Label } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { outcomeWord, tagCount, type RowSummary } from "@/lib/row-summary";
import { ChevronSmallIcon } from "../icons/drawn";

// The closed row's toggle sits underneath its text; anything here that takes clicks opts back in.
const interactive = "pointer-events-auto relative";

// The run's outcome as one quiet word after the name; amber only when it failed.
export function OutcomeWord({ label, className }: { label: Label | null; className?: string }) {
  const word = outcomeWord(label);
  if (word === null) return null;
  return (
    <span
      className={cn(
        "shrink-0 text-paragraph-small",
        word.problem ? "text-content-warning" : "text-content-tertiary",
        className,
      )}
    >
      <span className="sr-only">, outcome: </span>
      {word.text}
    </span>
  );
}

// The file's name on a row: its clean name, or the file name in mono until it has one.
export function RowName({ hit, label }: { hit: FileHit; label: Label | null }) {
  const named = label !== null && label.cleanName !== null;
  return (
    <span className={cn("line-clamp-2 min-w-0 text-label-medium [overflow-wrap:anywhere] text-content-primary sm:line-clamp-1", !named && "font-mono")}>
      {named ? label.cleanName : hit.locations[0].originalName}
    </span>
  );
}

// Amber, small and quiet: the label wants someone to look. It opens with the row, where
// Labels says what to do. The one-time hint points here.
export function CheckMark({ className }: { className?: string }) {
  return (
    <span
      data-hint="check-this"
      className={cn("inline-flex h-5 shrink-0 items-center rounded-md bg-background-warning px-1.5 text-label-xsmall text-content-warning", className)}
    >
      Check this
    </span>
  );
}

// The closed row's one line about its label: the experiment and person as plain words, and
// the tags behind a count that shows them in place.
export function SummaryLine({
  summary,
  tagsOpen,
  onToggleTags,
  tagsId,
  title,
}: {
  summary: RowSummary;
  tagsOpen: boolean;
  onToggleTags: () => void;
  tagsId: string;
  title: string;
}) {
  switch (summary.kind) {
    case "unlabeled":
      return null;
    case "needs_look":
      return <span className="mt-0.5 block text-paragraph-small text-content-tertiary">Not labeled yet, so it&apos;s in Needs a look</span>;
    case "labeled": {
      const count = tagCount(summary.tags.length);
      if (summary.facts.length === 0 && count === null) return null;
      return (
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-paragraph-small text-content-secondary sm:flex-nowrap">
          {summary.facts.length === 0 ? null : <span className="min-w-0 sm:truncate">{summary.facts.join(" · ")}</span>}
          {count === null ? null : (
            // The dot travels with the count, so a wrap never leaves it hanging.
            <span className="inline-flex shrink-0 items-center gap-1.5">
              {summary.facts.length === 0 ? null : <span aria-hidden>·</span>}
              <button
                type="button"
                aria-expanded={tagsOpen}
                aria-controls={tagsId}
                onClick={onToggleTags}
                className={cn(
                  interactive,
                  "-mx-1 inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 text-content-secondary underline decoration-content-tertiary decoration-dotted underline-offset-4 transition-colors duration-150 ease-out hover:bg-background-tertiary hover:text-content-primary max-sm:after:absolute max-sm:after:-inset-y-3 max-sm:after:inset-x-0",
                )}
              >
                {count}
                <ChevronSmallIcon className={cn("size-4 transition-transform duration-150 ease-out", tagsOpen ? "-rotate-90" : "rotate-90")} />
                <span className="sr-only">
                  {tagsOpen ? ", hide" : ", show"} the tags of {title}
                </span>
              </button>
            </span>
          )}
        </span>
      );
    }
    default: {
      const _exhaustive: never = summary;
      return _exhaustive;
    }
  }
}

// The tags a closed row shows in place once their count is clicked. Reading only; they edit
// in the opened row's Labels.
export function TagList({ tags, id }: { tags: readonly string[]; id: string }) {
  return (
    <span id={id} className="mt-1.5 flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span key={tag} className="inline-flex h-6 items-center rounded-md bg-background-tertiary px-2 text-label-xsmall text-content-secondary">
          {tag}
        </span>
      ))}
    </span>
  );
}

