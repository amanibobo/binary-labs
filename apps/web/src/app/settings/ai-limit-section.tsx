"use client";

import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { AI_CAP_MAX_USD, dollars, spendText } from "@/lib/ai-spend";
import type { Budget } from "@/lib/answers";
import { setAiCap, type AiCapState } from "./actions";
import { SettingsRow } from "./settings-frame";

// What asking the lab has cost this month against its limit. Everyone sees it; admins set it.
export function AiLimitRow({ budget, isAdmin }: { budget: Budget; isAdmin: boolean }) {
  return (
    <SettingsRow label="AI spending this month" action={isAdmin ? <AiLimitForm capUsd={budget.capUsd} /> : <span className="text-paragraph-medium text-content-secondary">{dollars(budget.capUsd)} a month</span>}>
      <p>{spendText(budget)}</p>
      <p className="mt-1">Questions asked in Search and suggested edits share this limit. Answers asked before still open once it&apos;s reached.</p>
    </SettingsRow>
  );
}

function AiLimitForm({ capUsd }: { capUsd: number }) {
  const [state, action, pending] = useActionState<AiCapState, FormData>(setAiCap, { kind: "idle" });
  const id = useId();
  return (
    <form action={action} className="grid gap-1.5">
      <label htmlFor={`${id}-cap`} className="text-paragraph-small text-content-tertiary">
        Monthly limit in US dollars
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={`${id}-cap`}
          name="cap"
          size="compact"
          inputMode="decimal"
          type="number"
          min={0}
          max={AI_CAP_MAX_USD}
          step="0.01"
          defaultValue={state.kind === "error" ? state.typed : String(state.kind === "saved" ? state.capUsd : capUsd)}
          key={state.kind === "saved" ? `saved-${state.capUsd}` : "draft"}
          aria-invalid={state.kind === "error"}
          aria-describedby={`${id}-status`}
          className="w-28"
          required
        />
        <Button type="submit" variant="secondary" size="compact" disabled={pending}>
          {pending ? "Saving" : "Save"}
        </Button>
      </div>
      <p id={`${id}-status`} role="status" className="min-h-5 text-paragraph-small text-content-tertiary">
        {state.kind === "error" ? state.message : state.kind === "saved" ? `Saved. The limit is ${dollars(state.capUsd)} a month.` : null}
      </p>
    </form>
  );
}
