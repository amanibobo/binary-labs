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

// sample_layouts.id: a plate's layout saved to use again, usually on a protocol.
export const LayoutId = z.uuid().brand<"LayoutId">();
export type LayoutId = z.infer<typeof LayoutId>;

// A table column by its spreadsheet letter (A, B, … AA), which stays put however it's named.
export const ColumnId = z.string().regex(/^[A-Z]{1,3}$/, "expected a column letter").brand<"ColumnId">();
export type ColumnId = z.infer<typeof ColumnId>;

// instruments.id: one instrument PC whose uploader sends files to the lab.
export const InstrumentId = z.uuid().brand<"InstrumentId">();
export type InstrumentId = z.infer<typeof InstrumentId>;

// One check on a protocol version; it keeps its id across versions, so its flags add up.
export const CheckId = z.uuid().brand<"CheckId">();
export type CheckId = z.infer<typeof CheckId>;

// flags.id: one failed check of one file.
export const FlagId = z.uuid().brand<"FlagId">();
export type FlagId = z.infer<typeof FlagId>;

// questions.id: one question someone asked the lab, with its answer.
export const QuestionId = z.uuid().brand<"QuestionId">();
export type QuestionId = z.infer<typeof QuestionId>;

// suggestions.id: one change the AI proposed, waiting for a member to approve or dismiss it.
export const SuggestionId = z.uuid().brand<"SuggestionId">();
export type SuggestionId = z.infer<typeof SuggestionId>;

// runs.id: one attempt at an experiment, with its files as evidence.
export const RunId = z.uuid().brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

// run_debriefs.id: one spoken or typed debrief of a run.
export const DebriefId = z.uuid().brand<"DebriefId">();
export type DebriefId = z.infer<typeof DebriefId>;
