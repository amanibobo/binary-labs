"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { PlanChoice } from "@/lib/as-run";
import { formatInstant } from "@/lib/format";
import type { RunId } from "@/lib/ids";
import { useRunsApi } from "../runs-api";

const textInput =
  "h-8 w-full rounded-md border border-border-opaque bg-background-primary px-2 text-paragraph-small text-content-primary max-sm:h-11 max-sm:text-paragraph-medium";

function choiceMeta(choice: PlanChoice): string {
  return [
    `Version ${choice.version}`,
    `saved ${formatInstant(choice.savedAt, "UTC")}`,
    choice.suggested ? "the newest on the day this run started" : choice.current ? "the newest" : null,
  ]
    .filter((p) => p !== null)
    .join(" · ");
}

// Type to find the protocol; the version that was newest when the run started comes first,
// then the experiment's other versions, then the lab's other protocols.
export function PlanPicker({ runId, onPick, onCancel }: { runId: RunId; onPick: (choice: PlanChoice) => void; onCancel: () => void }) {
  const api = useRunsApi();
  const [query, setQuery] = useState("");
  const inputId = useId();
  const choices = useQuery({
    queryKey: ["run-plan-choices", runId, query.trim()],
    queryFn: ({ signal }) => api.planChoices(runId, query.trim(), signal),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
  });
  const list = choices.data ?? [];
  return (
    <div
      className="grid w-full max-w-md gap-1"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Find the protocol
      </label>
      <input id={inputId} autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find the protocol by name" className={textInput} />
      <ul aria-label="Protocols" aria-busy={choices.isFetching} className="grid">
        {list.map((choice) => (
          <li key={choice.versionId}>
            <button
              type="button"
              onClick={() => onPick(choice)}
              className="grid min-h-8 w-full min-w-0 rounded-md px-2 py-1 text-left text-paragraph-small hover:bg-background-tertiary max-sm:min-h-11"
            >
              <span className="truncate text-content-primary">
                {choice.title}
                {choice.picked ? <span className="text-content-tertiary"> (picked now)</span> : null}
              </span>
              <span className="text-paragraph-xsmall text-content-tertiary">{choiceMeta(choice)}</span>
            </button>
          </li>
        ))}
      </ul>
      {choices.isSuccess && list.length === 0 ? <p className="px-2 text-paragraph-small text-content-tertiary">No protocols match.</p> : null}
      {choices.isError ? <p className="px-2 text-paragraph-small text-content-primary">We couldn&apos;t list the protocols. Try again.</p> : null}
    </div>
  );
}
