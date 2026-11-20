import type { Label, LabelCondition, LabelOutcome, NoteKind } from "./domain";
import { UNCLEAR } from "./domain";

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

// The quiet word after a row's name. Only "failed" is a problem, so only it takes amber.
export const OUTCOME_WORDS: Record<LabelOutcome, string> = {
  worked: "worked",
  failed: "failed",
  repeat: "a repeat",
  final: "final",
  unclear: "outcome unclear",
};

export function outcomeWord(label: Label | null): { text: string; problem: boolean } | null {
  if (label === null || label.status === "needs_look" || label.outcome === null) return null;
  return { text: OUTCOME_WORDS[label.outcome], problem: label.outcome === "failed" };
}

// The same outcomes as Search's filter names them, where each stands alone in a menu or a chip.
export const OUTCOME_FILTER_NAMES: Record<LabelOutcome, string> = {
  worked: "Worked",
  failed: "Failed",
  repeat: "A repeat",
  final: "Final",
  unclear: "Outcome unclear",
};

// The choices in Labels, in the order a run goes, and None for protocols, papers and anything
// that isn't a run. "A repeat" is a re-run of an earlier one, not one that needs repeating.
export const OUTCOME_CHOICES: readonly { value: LabelOutcome | null; text: string }[] = [
  { value: "worked", text: "Worked" },
  { value: "failed", text: "Failed" },
  { value: "repeat", text: "A repeat" },
  { value: "final", text: "Final" },
  { value: "unclear", text: "Unclear" },
  { value: null, text: "None" },
];

export const NOTE_KIND_NAMES: Record<NoteKind, string> = {
  experiment_notes: "Experiment notes",
  meeting_notes: "Meeting notes",
  reading_summary: "Reading summary",
  lecture: "Lecture",
  protocol: "Protocol",
  data: "Data",
  image: "Image",
  other: "Other",
};

// "12 pages" on a note's row.
export function pageCount(label: Label | null): string | null {
  const pages = label?.note?.pages.length ?? 0;
  return pages < 2 ? null : `${pages} pages`;
}

// One condition as it reads: "drug A 0.1–100 µM", "37 °C", "triplicate". A value Binary
// couldn't read says so instead of a number.
export function conditionText(c: LabelCondition): string {
  if (c.value === null) return c.what;
  if (isUnclear(c)) return `${c.what}: not clear`;
  const value = c.unit === null ? c.value : `${c.value} ${c.unit}`;
  // A value that names itself ("37 °C" for temperature, "triplicate" for replicates) reads alone.
  const generic = ["temperature", "time", "duration", "incubation", "replicates"];
  if (generic.includes(c.what.toLowerCase())) return value;
  return `${c.what} ${value}`;
}

export function isUnclear(c: LabelCondition): boolean {
  return c.value !== null && c.value.includes(UNCLEAR);
}

// The opened row shows this many conditions before "and N more".
export const SHOWN_CONDITIONS = 5;

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
