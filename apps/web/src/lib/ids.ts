import { z } from "zod";

export const LabId = z.uuid().brand<"LabId">();
export type LabId = z.infer<typeof LabId>;

export const SourceId = z.uuid().brand<"SourceId">();
export type SourceId = z.infer<typeof SourceId>;

export const UserId = z.uuid().brand<"UserId">();
export type UserId = z.infer<typeof UserId>;

export const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a lowercase hex sha256")
  .brand<"Sha256">();
export type Sha256 = z.infer<typeof Sha256>;

// experiments.id and people.id sit side by side in correct_label's arguments; the brands keep them apart.
export const ExperimentId = z.uuid().brand<"ExperimentId">();
export type ExperimentId = z.infer<typeof ExperimentId>;

export const PersonId = z.uuid().brand<"PersonId">();
export type PersonId = z.infer<typeof PersonId>;

// corrections.id is a bigint; JSON carries it as a number well inside 2^53.
export const CorrectionId = z.number().int().positive().brand<"CorrectionId">();
export type CorrectionId = z.infer<typeof CorrectionId>;
