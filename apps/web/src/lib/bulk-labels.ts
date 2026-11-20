import { z } from "zod";
import { IsoDate, LabelOutcome, LabelRow, LabelWire, type ExperimentRef, type Label, type PersonRef } from "./domain";
import { CorrectionId, ExperimentId, PersonId, Sha256, type LabId } from "./ids";
import { draftOf, type LabelDraft } from "./label-edit";
import { OUTCOME_CHOICES } from "./row-summary";

// One change to many files' labels at once: a field and the value every chosen file gets.
// correct_labels (0029_labels_many.sql) applies the same rules on the server; bulkDraft here
// shows the count and the new labels before it answers.
export type BulkChange =
  | { field: "experiment"; value: ExperimentRef | null }
  | { field: "person"; value: PersonRef | null }
  | { field: "instrument"; value: string | null }
  | { field: "date"; value: string | null }
  | { field: "outcome"; value: LabelOutcome | null }
  | { field: "add_tag"; value: string }
  | { field: "remove_tag"; value: string };

export type BulkField = BulkChange["field"];

export const MAX_BULK_FILES = 200;
const MAX_TAGS = 20;

// What one file does under a change: takes the new label, already has it, has no name yet
// (Needs a look, or not labeled yet), or has no room for another tag.
export type BulkStep = { kind: "change"; draft: LabelDraft } | { kind: "same" } | { kind: "unnamed" } | { kind: "full" };

export function bulkDraft(label: Label | null, change: BulkChange): BulkStep {
  const current = label === null ? null : draftOf(label);
  if (current === null) return { kind: "unnamed" };
  const set = (draft: LabelDraft, same: boolean): BulkStep => (same ? { kind: "same" } : { kind: "change", draft });
  switch (change.field) {
    case "experiment":
      return set({ ...current, experiment: change.value }, current.experiment?.id === change.value?.id);
    case "person":
      return set({ ...current, person: change.value }, current.person?.id === change.value?.id);
    case "instrument":
      return set({ ...current, instrument: change.value }, current.instrument === change.value);
    case "date":
      return set({ ...current, date: change.value }, current.date === change.value);
    case "outcome":
      return set({ ...current, outcome: change.value }, current.outcome === change.value);
    case "add_tag":
      if (current.tags.includes(change.value)) return { kind: "same" };
      if (current.tags.length >= MAX_TAGS) return { kind: "full" };
      return { kind: "change", draft: { ...current, tags: [...current.tags, change.value] } };
    case "remove_tag":
      return set({ ...current, tags: current.tags.filter((t) => t !== change.value) }, !current.tags.includes(change.value));
    default: {
      const _exhaustive: never = change;
      return _exhaustive;
    }
  }
}

export type BulkItem = { sha256: Sha256; label: Label | null };
export type BulkPlan = {
  changes: { sha256: Sha256; before: Label; draft: LabelDraft }[];
  same: number;
  unnamed: number;
  full: number;
};

export function planBulk(items: readonly BulkItem[], change: BulkChange): BulkPlan {
  const plan: BulkPlan = { changes: [], same: 0, unnamed: 0, full: 0 };
  const seen = new Set<Sha256>();
  for (const { sha256, label } of items) {
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    const step = bulkDraft(label, change);
    if (step.kind === "change" && label !== null) plan.changes.push({ sha256, before: label, draft: step.draft });
    else if (step.kind === "same") plan.same += 1;
    else if (step.kind === "full") plan.full += 1;
    else plan.unnamed += 1;
  }
  return plan;
}

const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);
const outcomeText = (o: LabelOutcome) => OUTCOME_CHOICES.find((c) => c.value === o)?.text.toLowerCase() ?? o;

// "Set the experiment to HeLa drug A": what the change does, as the button and the toast say it.
export function changeTitle(change: BulkChange, formatDay: (iso: string) => string): string {
  switch (change.field) {
    case "experiment":
      return change.value === null ? "Clear the experiment" : `Set the experiment to ${change.value.name}`;
    case "person":
      return change.value === null ? "Clear the person" : `Set the person to ${change.value.name}`;
    case "instrument":
      return change.value === null ? "Clear the instrument" : `Set the instrument to ${change.value}`;
    case "date":
      return change.value === null ? "Clear the date" : `Set the date to ${formatDay(change.value)}`;
    case "outcome":
      return change.value === null ? "Clear the outcome" : `Mark as ${outcomeText(change.value)}`;
    case "add_tag":
      return `Add the tag “${change.value}”`;
    case "remove_tag":
      return `Remove the tag “${change.value}”`;
    default: {
      const _exhaustive: never = change;
      return _exhaustive;
    }
  }
}

// What a plan will do, counted: "Changes 3 files. 1 already has it. 1 has no name yet, so
// it's left out."
export function planLine(plan: Pick<BulkPlan, "same" | "unnamed" | "full"> & { changed: number }): string {
  const parts = [plan.changed === 0 ? "Nothing to change." : `Changes ${files(plan.changed)}.`];
  if (plan.same > 0) parts.push(plan.same === 1 ? "1 already has it." : `${plan.same} already have it.`);
  if (plan.unnamed > 0) parts.push(plan.unnamed === 1 ? "1 has no name yet, so it's left out." : `${plan.unnamed} have no name yet, so they're left out.`);
  if (plan.full > 0) parts.push(plan.full === 1 ? `1 already has ${MAX_TAGS} tags.` : `${plan.full} already have ${MAX_TAGS} tags.`);
  return parts.join(" ");
}

// What the browser sends to /api/labels/bulk. Ids, not names: the server checks them.
const WireChange = z.discriminatedUnion("field", [
  z.object({ field: z.literal("experiment"), value: ExperimentId.nullable() }),
  z.object({ field: z.literal("person"), value: PersonId.nullable() }),
  z.object({ field: z.literal("instrument"), value: z.string().trim().min(1).max(120).nullable() }),
  z.object({ field: z.literal("date"), value: IsoDate.nullable() }),
  z.object({ field: z.literal("outcome"), value: LabelOutcome.nullable() }),
  z.object({ field: z.literal("add_tag"), value: z.string().trim().min(1).max(200) }),
  z.object({ field: z.literal("remove_tag"), value: z.string().trim().min(1).max(200) }),
]);
export const BulkRequest = z.object({ shas: z.array(Sha256).min(1).max(MAX_BULK_FILES), change: WireChange });
export type BulkRequest = z.infer<typeof BulkRequest>;

export function bulkRequest(shas: readonly Sha256[], change: BulkChange): BulkRequest {
  const wire = (): BulkRequest["change"] => {
    switch (change.field) {
      case "experiment":
        return { field: "experiment", value: change.value?.id ?? null };
      case "person":
        return { field: "person", value: change.value?.id ?? null };
      default:
        return change;
    }
  };
  return { shas: [...shas], change: wire() };
}

export const BatchId = z.uuid().brand<"BatchId">();
export type BatchId = z.infer<typeof BatchId>;

const ChangedRow = z
  .object({ sha256: Sha256, correction_id: CorrectionId, label: LabelRow })
  .transform((r) => ({ sha256: r.sha256, correctionId: r.correction_id, label: r.label }));
const ChangedWire = z.object({ sha256: Sha256, correctionId: CorrectionId, label: LabelWire });

// correct_labels' answer as the database returns it, and as our route sends it on.
export const BulkResultRow = z
  .object({ batch_id: BatchId.nullable(), changed: z.array(ChangedRow), same: z.number(), unnamed: z.number(), full: z.number() })
  .transform(({ batch_id, ...r }) => ({ batchId: batch_id, ...r }));
export const BulkResultWire = z.object({
  batchId: BatchId.nullable(),
  changed: z.array(ChangedWire),
  same: z.number(),
  unnamed: z.number(),
  full: z.number(),
});
export type BulkResult = z.infer<typeof BulkResultWire>;

export const UndoBatchRequest = z.object({ batchId: BatchId });
export const UndoBatchRow = z.object({ undone: z.array(ChangedRow), skipped: z.number() });
export const UndoBatchWire = z.object({ undone: z.array(ChangedWire), skipped: z.number() });
export type UndoBatchResult = z.infer<typeof UndoBatchWire>;

export function correctLabelsArgs(labId: LabId, req: BulkRequest) {
  return { p_lab_id: labId, p_shas: req.shas, p_change: req.change };
}

// correct_labels and undo_label_batch raise these; everything else is our fault.
export function bulkFailure(error: { code?: string }): { status: number; message: string } {
  switch (error.code) {
    case "BL801":
      return { status: 400, message: "Check the change and try again." };
    case "BL802":
      return { status: 400, message: "That isn't in the lab's lists any more. Reload and try again." };
    case "BL803":
      return { status: 400, message: `Change up to ${MAX_BULK_FILES} files at once.` };
    case "BL002":
      return { status: 409, message: "There's nothing to undo." };
    case "42501":
      return { status: 403, message: "You're not a member of this lab." };
    default:
      return { status: 500, message: "We couldn't save that. Try again." };
  }
}

// After an undo: "Undone" when every file went back, else how many kept a newer change.
export function undoLine(result: UndoBatchResult): string {
  if (result.skipped === 0) return "Change undone";
  const kept = result.skipped === 1 ? "1 file was changed since and keeps its newer label" : `${result.skipped} files were changed since and keep their newer labels`;
  return result.undone.length === 0 ? `Nothing undone. ${kept[0].toUpperCase()}${kept.slice(1)}.` : `Undone on ${files(result.undone.length)}. ${kept}.`;
}
