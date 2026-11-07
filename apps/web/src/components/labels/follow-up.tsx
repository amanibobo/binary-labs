"use client";

import { useState } from "react";
import type { FollowUp } from "@/lib/domain";
import { useLabels, type LabeledFile } from "./labels-context";

// One short question a voice note left open ("that thing from Tuesday"), answered with one
// tap. The answer is a correction like any other, so it can be undone and it teaches Binary.
export function FollowUpQuestion({ hit, followUp, className }: { hit: LabeledFile; followUp: FollowUp; className?: string }) {
  const labels = useLabels();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className={className}>
      <p className="text-paragraph-small text-content-primary">{followUp.question}</p>
      <div role="group" aria-label={followUp.question} className="mt-1.5 flex flex-wrap gap-1.5">
        {followUp.choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            onClick={() => {
              const outcome = labels.edit(hit, { kind: "answer", field: followUp.field, value: choice.value }, `Saved: ${choice.label}`);
              setProblem(outcome.kind === "invalid" ? outcome.message : null);
            }}
            className="inline-flex min-h-8 items-center rounded-md px-2.5 text-label-small text-content-primary ring-1 ring-border-opaque ring-inset transition-colors duration-150 ease-out hover:bg-background-tertiary max-sm:min-h-11"
          >
            {choice.label}
          </button>
        ))}
      </div>
      {problem === null ? null : (
        <p role="alert" className="mt-1 text-paragraph-xsmall text-content-primary">
          {problem}
        </p>
      )}
    </div>
  );
}
