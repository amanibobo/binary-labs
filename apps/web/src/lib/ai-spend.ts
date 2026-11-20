import { z } from "zod";
import type { Budget } from "./answers";

// The lab's monthly limit on questions and suggestions, as Settings > General says it.

export const AI_CAP_MAX_USD = 1000;

export const AiCapInput = z.coerce
  .number({ error: "Enter an amount in dollars, like 25." })
  .finite("Enter an amount in dollars, like 25.")
  .min(0, "The limit can't be below $0.")
  .max(AI_CAP_MAX_USD, `Keep the limit at $${AI_CAP_MAX_USD} or less.`);

export function dollars(usd: number): string {
  if (usd > 0 && usd < 0.01) return "less than $0.01";
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

function resetDay(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(iso));
}

export function spendText(budget: Budget): string {
  const resets = resetDay(budget.resetsAt);
  if (budget.capUsd === 0) return "The limit is $0, so asking the lab and suggestions are off.";
  if (budget.spentUsd >= budget.capUsd) {
    return `The lab has used all of this month's ${dollars(budget.capUsd)}. Asking starts again on ${resets}.`;
  }
  const used = dollars(budget.spentUsd);
  return `${used.charAt(0).toUpperCase()}${used.slice(1)} of ${dollars(budget.capUsd)} used this month. It starts again on ${resets}.`;
}
