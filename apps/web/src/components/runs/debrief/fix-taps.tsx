"use client";

import { useId } from "react";
import { FIX_CHOICES } from "@/lib/debrief";
import type { RunFix } from "@/lib/run-record";
import { Button } from "../../ui/button";

// Question 5's tap. Never read from the words: the scientist says it here, or it's missing.
export function FixTaps({ value, disabled, onPick }: { value: RunFix | null; disabled: boolean; onPick: (fix: RunFix | null) => void }) {
  const ids = useId();
  return (
    <fieldset className="mt-8">
      <legend id={ids} className="text-label-medium text-content-primary">
        Did the change fix it?
      </legend>
      <div role="group" aria-labelledby={ids} className="mt-2 flex flex-wrap gap-2">
        {FIX_CHOICES.map((c) => (
          <Button
            key={c.fix}
            variant={value === c.fix ? "primary" : "secondary"}
            aria-pressed={value === c.fix}
            disabled={disabled}
            onClick={() => onPick(value === c.fix ? null : c.fix)}
          >
            {c.label}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}
