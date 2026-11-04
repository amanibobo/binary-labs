import { z } from "zod";
import { IsoDate } from "./domain";
import { CorrectionId, ExperimentId, PersonId, Sha256, type LabId } from "./ids";
import type { LabelDraft } from "./label-edit";

// What the browser sends to /api/labels/correct: the full label, as correct_label replaces every field.
export const CorrectRequest = z.object({
  sha256: Sha256,
  cleanName: z.string().trim().min(1).max(200),
  date: IsoDate.nullable(),
  experimentId: ExperimentId.nullable(),
  personId: PersonId.nullable(),
  instrument: z.string().trim().max(120).nullable(),
  tags: z.array(z.string().max(200)).max(20),
});
export type CorrectRequest = z.infer<typeof CorrectRequest>;

export function correctRequest(sha256: Sha256, draft: LabelDraft): CorrectRequest {
  return {
    sha256,
    cleanName: draft.cleanName,
    date: draft.date,
    experimentId: draft.experiment?.id ?? null,
    personId: draft.person?.id ?? null,
    instrument: draft.instrument,
    tags: draft.tags,
  };
}

export type CorrectLabelArgs = {
  p_lab_id: LabId;
  p_sha256: Sha256;
  p_clean_name: string;
  p_date: string | null;
  p_experiment_id: ExperimentId | null;
  p_person_id: PersonId | null;
  p_instrument: string | null;
  p_tags: string[];
};

export function correctLabelArgs(labId: LabId, req: CorrectRequest): CorrectLabelArgs {
  return {
    p_lab_id: labId,
    p_sha256: req.sha256,
    p_clean_name: req.cleanName,
    p_date: req.date,
    p_experiment_id: req.experimentId,
    p_person_id: req.personId,
    p_instrument: req.instrument,
    p_tags: req.tags,
  };
}

export const UndoRequest = z.object({ correctionId: CorrectionId });

export const MAX_POLLED_SHAS = 50;

export const FileLabelsQuery = z.object({
  shas: z
    .string()
    .transform((s) => s.split(","))
    .pipe(z.array(Sha256).min(1).max(MAX_POLLED_SHAS)),
});

// corrections_apply raises these; everything else is our fault, not the person's.
export function correctionFailure(error: { code?: string; message: string }): { status: number; message: string } {
  switch (error.code) {
    case "P0002":
      if (error.message.includes("already undone")) return { status: 409, message: "That change was already undone." };
      if (error.message.includes("nothing to undo")) return { status: 409, message: "There's nothing to undo." };
      return { status: 409, message: "This file doesn't have a label yet." };
    case "40001":
      return { status: 409, message: "The label changed since, so that undo no longer applies." };
    case "23514":
      return { status: 400, message: "A label needs a name." };
    case "42501":
      return { status: 403, message: "You're not a member of this lab." };
    default:
      return { status: 500, message: "We couldn't save that. Try again." };
  }
}
