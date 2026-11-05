import { z } from "zod";

export const LabId = z.uuid().brand<"LabId">();
export type LabId = z.infer<typeof LabId>;

export const SourceId = z.uuid().brand<"SourceId">();
export type SourceId = z.infer<typeof SourceId>;

export const UserId = z.uuid().brand<"UserId">();
export type UserId = z.infer<typeof UserId>;

// file_locations.id: one place a file lives. An upload is one too, so routes take it to find the bytes.
export const LocationId = z.uuid().brand<"LocationId">();
export type LocationId = z.infer<typeof LocationId>;

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

// A page and one saved version of it; save_protocol takes both side by side.
export const ProtocolId = z.uuid().brand<"ProtocolId">();
export type ProtocolId = z.infer<typeof ProtocolId>;

export const ProtocolVersionId = z.uuid().brand<"ProtocolVersionId">();
export type ProtocolVersionId = z.infer<typeof ProtocolVersionId>;

// talk_throughs.id: one recording someone made to explain a procedure.
export const TalkThroughId = z.uuid().brand<"TalkThroughId">();
export type TalkThroughId = z.infer<typeof TalkThroughId>;

// corrections.id is a bigint; JSON carries it as a number well inside 2^53.
export const CorrectionId = z.number().int().positive().brand<"CorrectionId">();
export type CorrectionId = z.infer<typeof CorrectionId>;

// charts.id: one saved chart of a file's table.
export const ChartId = z.uuid().brand<"ChartId">();
export type ChartId = z.infer<typeof ChartId>;

// A table column by its spreadsheet letter (A, B, … AA), which stays put however it's named.
export const ColumnId = z.string().regex(/^[A-Z]{1,3}$/, "expected a column letter").brand<"ColumnId">();
export type ColumnId = z.infer<typeof ColumnId>;
