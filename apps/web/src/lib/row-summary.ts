import type { Label } from "./domain";

// What a closed search row says about its label, in one muted line: at most two facts (the
// experiment and person, or the instrument when one is missing), the number of free tags
// behind a toggle, and whether the label wants a look. Everything else waits for the opened row.
export type RowSummary =
  | { kind: "unlabeled" }
  | { kind: "needs_look" }
  | { kind: "labeled"; facts: string[]; tags: readonly string[]; check: boolean };

export const MAX_FACTS = 2;

export function rowSummary(label: Label | null): RowSummary {
  if (label === null) return { kind: "unlabeled" };
  if (label.status === "needs_look") return { kind: "needs_look" };
  const facts = [label.experiment?.name, label.person?.name, label.instrument]
    .filter((fact): fact is string => fact !== undefined && fact !== null && fact.trim() !== "")
    .slice(0, MAX_FACTS);
  return { kind: "labeled", facts, tags: label.tags, check: label.status === "check" };
}

// "5 tags" on the toggle that shows them in place.
export function tagCount(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? "1 tag" : `${count} tags`;
}

// A short preview's first lines: a long text box gets "Show more" when it holds more than
// this many lines or characters.
export function textOverflows(text: string, { lines = 8, chars = 480 }: { lines?: number; chars?: number } = {}): boolean {
  return text.split("\n").length > lines || text.length > chars;
}
