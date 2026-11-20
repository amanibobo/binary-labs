import { z } from "zod";
import { FILE_KINDS, FileKind } from "./domain";
import { ExperimentId, PersonId, RunId, Sha256, UserId } from "./ids";
import { ConfirmMethod, fromRow, RunFileRole, RunFix, RunStatus } from "./run-record";

// The task folder (decisions.md, "the run record: de-identification and the task folder"):
// one run, de-identified, as a folder an outside team can pose to a model. These are the
// shapes the page, the routes and the builder share. Nothing here reads or writes.

// ---- Why a run can't become a folder yet.

// run_export_blocks (0034, 0041): consent. A grant the database refused is "no_grant".
export const SHARE_BLOCKS = ["run_off", "lab_off", "demo_lab", "not_attested"] as const;
// task_export_gaps (0039): what the task still lacks.
export const TASK_GAPS = ["no_confirmed_cause", "no_task", "no_review", "no_protocol", "file_not_kept", "excluded_experiment"] as const;
export const ExportReason = z.enum([...SHARE_BLOCKS, ...TASK_GAPS, "no_grant"]);
export type ExportReason = z.infer<typeof ExportReason>;

// One line each, and what to do about it. A first-year student reads these.
export const REASON_LINES = {
  no_confirmed_cause: "Nobody has confirmed what went wrong yet. Write the confirmed cause on the run's page.",
  not_attested: "The person named as confirming the cause hasn't said so themselves. Ask them to open the run and tap “Yes, I confirmed this”.",
  no_task: "The question and rubric aren't written yet.",
  no_review: "A second scientist hasn't reviewed the cause yet. It has to be someone other than the person who ran it.",
  no_protocol: "The run has no protocol. On the run's page, pick the protocol it followed or write what was actually done.",
  file_not_kept: "Binary is still saving its copy of one of the run's files. Try again in a few minutes.",
  excluded_experiment: "This lab leaves this run's experiment out of anything shared.",
  run_off: "Sharing is off for this run. The person who ran it, or an admin, turns it on from the run's page.",
  lab_off: "The lab hasn't agreed to share anything yet. An admin does that in Settings.",
  demo_lab: "This is a demo lab. Its data is made up, so nothing leaves it.",
  no_grant: "Binary couldn't confirm that this run may be shared just now. Try again.",
} as const satisfies Record<ExportReason, string>;

// ---- What a lab leaves out.

export const ExclusionKind = z.enum(["field", "text", "folder", "experiment"]);
export type ExclusionKind = z.infer<typeof ExclusionKind>;
export const Exclusion = z.object({ kind: z.string(), value: z.string() });
export type Exclusion = z.infer<typeof Exclusion>;

const KIND_WORDS = { pdf: "PDFs", spreadsheet: "Spreadsheets", document: "Documents", text: "Text files", image: "Images", other: "Other files", audio: "Audio", video: "Video" } as const satisfies Record<FileKind, string>;

// The parts of a record a lab can leave out (kind "field"). The answer key, the question,
// the rubric and the review can't be left out: without them there is no task.
export const EXCLUDABLE_FIELDS = [
  { value: "suspected_cause", label: "The suspected cause" },
  { value: "confirm_note", label: "The note on how the cause was confirmed" },
  { value: "debrief", label: "The debrief answers" },
  { value: "protocol_as_written", label: "The protocol as written" },
  { value: "experiment", label: "The experiment's name" },
  ...FILE_KINDS.map((kind) => ({ value: `evidence.${kind}`, label: KIND_WORDS[kind] })),
] as const satisfies readonly { value: string; label: string }[];
const FIELD_VALUES = new Set<string>(EXCLUDABLE_FIELDS.map((f) => f.value));

export const SetExclusionRequest = z
  .object({ kind: ExclusionKind, value: z.string().trim().min(1, "Say what to leave out.").max(400), on: z.boolean() })
  .refine((x) => x.kind !== "field" || FIELD_VALUES.has(x.value), "That isn't a part of the record.");

export function exclusionLabel(x: Exclusion): string {
  if (x.kind === "field") return EXCLUDABLE_FIELDS.find((f) => f.value === x.value)?.label ?? x.value;
  if (x.kind === "folder") return `Files in ${x.value}`;
  if (x.kind === "experiment") return "One experiment's runs";
  return `“${x.value}”`;
}

// ---- The task a second scientist writes.

export const MAX_CRITERIA = 20;
export const RubricItem = z.object({
  criterion: z.string().trim().min(1, "Write what a good answer says, or remove the empty line.").max(500),
  points: z.number().int().min(1).max(10),
});
export type RubricItem = z.infer<typeof RubricItem>;

export const SaveTaskRequest = z.object({
  question: z.string().trim().min(1, "Write the question.").max(4000),
  rubric: z.array(RubricItem).min(1, "Add at least one thing a good answer says.").max(MAX_CRITERIA),
  reviewerId: PersonId,
  notes: z.string().trim().min(1, "Write a line or two of review notes.").max(8000),
  agrees: z.boolean().nullable(),
});
export type SaveTaskRequest = z.infer<typeof SaveTaskRequest>;

const Timestamp = z.string();
export const BuiltFolder = z.object({
  id: z.uuid(),
  builtAt: Timestamp,
  withdrawnAt: Timestamp.nullable(),
  hasFiles: z.boolean(),
  files: z.number(),
  bytes: z.number().nullable(),
});
export type BuiltFolder = z.infer<typeof BuiltFolder>;

// The task as its page shows it (run_task_json).
export const RunTask = z.object({
  runId: RunId,
  question: z.string().nullable(),
  rubric: z.array(RubricItem),
  writtenAt: Timestamp.nullable(),
  review: z
    .object({ reviewer: z.object({ id: PersonId, name: z.string() }).nullable(), notes: z.string(), agrees: z.boolean().nullable(), reviewedAt: Timestamp })
    .nullable(),
  ranBy: PersonId.nullable(),
  gaps: z.array(ExportReason),
  blocks: z.array(ExportReason),
  demo: z.boolean(),
  canExclude: z.boolean(),
  exclusions: z.array(Exclusion),
  exports: z.array(BuiltFolder),
});
export type RunTask = z.infer<typeof RunTask>;
export const RunTaskJson = fromRow(RunTask);

// ---- Everything a folder is built from, names included (task_export_source).

const Term = z.object({ code: z.string(), label: z.string() }).nullable();
export const TaskSource = z.object({
  run: z.object({
    id: RunId,
    title: z.string(),
    startedOn: z.string().nullable(),
    endedOn: z.string().nullable(),
    status: RunStatus.nullable(),
    statusBy: UserId.nullable(),
    statusAt: Timestamp.nullable(),
    experiment: z.string().nullable(),
    personId: PersonId.nullable(),
    retryOf: RunId.nullable(),
    suspectedCause: z.string().nullable(),
    confirmedCause: z.string().nullable(),
    confirmedBy: PersonId.nullable(),
    confirmMethod: ConfirmMethod.nullable(),
    confirmNote: z.string().nullable(),
    confirmRun: RunId.nullable(),
    confirmSha256: Sha256.nullable(),
    confirmedAt: Timestamp.nullable(),
    confirmRecordedBy: UserId.nullable(),
    confirmerAttestedAt: Timestamp.nullable(),
    taxonomyVersion: z.number().nullable(),
    technique: Term,
    failedStep: Term,
    causeCategory: Term,
    aim: z.string().nullable(),
    expectedSeen: z.string().nullable(),
    howFound: z.string().nullable(),
    whatChanged: z.string().nullable(),
    fixWorked: RunFix.nullable(),
    whoElse: z.string().nullable(),
    asRunBody: z.string().nullable(),
    asRunBy: UserId.nullable(),
    asRunAt: Timestamp.nullable(),
  }),
  planned: z.object({ title: z.string(), version: z.number(), body: z.string() }).nullable(),
  task: z.object({ question: z.string(), rubric: z.array(RubricItem), writtenBy: UserId.nullable(), writtenAt: Timestamp }).nullable(),
  reviews: z.array(z.object({ reviewerId: PersonId.nullable(), notes: z.string(), agrees: z.boolean().nullable(), recordedBy: UserId.nullable(), reviewedAt: Timestamp })),
  files: z.array(
    z.object({ sha256: Sha256, role: RunFileRole, fileKind: FileKind, mime: z.string(), size: z.number(), originalName: z.string(), kept: z.boolean(), paths: z.array(z.string()) }),
  ),
  log: z.array(z.object({ at: Timestamp, action: z.string(), via: z.string(), actor: UserId.nullable(), changed: z.array(z.string()), share: z.boolean().nullable() })),
  people: z.array(z.object({ personId: PersonId.nullable(), userId: UserId.nullable(), names: z.array(z.string()), emails: z.array(z.string()) })),
  lab: z.object({ name: z.string(), demo: z.boolean(), agreement: z.string().nullable(), agreedAt: Timestamp.nullable(), agreedBy: UserId.nullable() }),
  exclusions: z.array(Exclusion),
  blocks: z.array(ExportReason),
  gaps: z.array(ExportReason),
});
export type TaskSource = z.infer<typeof TaskSource>;
export const TaskSourceJson = fromRow(TaskSource);

// ---- What the folder holds.

export const FOLDER_FORMAT = "binary-task/1";

// How a file of the run was treated. "scrubbed": a text file, names replaced in a copy.
// "as_is": bytes Binary can't look inside (an image, a workbook), exactly as kept.
export const EvidenceTreatment = z.enum(["scrubbed", "as_is"]);
export type EvidenceTreatment = z.infer<typeof EvidenceTreatment>;

export const LeftOutReason = z.enum(["kind_excluded", "folder_excluded", "too_big_to_check", "too_big", "not_kept"]);
export type LeftOutReason = z.infer<typeof LeftOutReason>;
export const LEFT_OUT_LINES = {
  kind_excluded: "The lab leaves this kind of file out.",
  folder_excluded: "The lab leaves this folder's files out.",
  too_big_to_check: "Too big for Binary to check for names.",
  too_big: "Too big to put in a folder.",
  not_kept: "Binary hasn't saved its copy of this file yet.",
} as const satisfies Record<LeftOutReason, string>;

export const EvidenceEntry = z.object({
  path: z.string(),
  role: RunFileRole,
  kind: FileKind,
  treatment: EvidenceTreatment,
  bytes: z.number(),
  // The content in the folder, and the kept original it came from (the same for "as_is").
  sha256: z.string(),
  sourceSha256: Sha256,
});
export type EvidenceEntry = z.infer<typeof EvidenceEntry>;

export const TaskManifest = z.object({
  format: z.literal(FOLDER_FORMAT),
  taskId: z.uuid(),
  runId: RunId,
  builtAt: Timestamp,
  // Made-up data never leaves; the flag is here so a folder can't lose its label.
  sample: z.boolean(),
  taxonomyVersion: z.number().nullable(),
  parts: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })),
  evidence: z.array(EvidenceEntry),
  leftOut: z.array(z.object({ kind: FileKind, role: RunFileRole, reason: LeftOutReason })),
  deidentification: z.object({
    people: z.number(),
    samples: z.number(),
    emails: z.number(),
    replacements: z.number(),
    excluded: z.array(z.string()),
    // Files nobody could check inside. A person looked at the preview before building.
    includedAsIs: z.array(z.string()),
  }),
  // Only on the copy kept beside the zip and in the database.
  zip: z.object({ bytes: z.number(), sha256: z.string() }).optional(),
});
export type TaskManifest = z.infer<typeof TaskManifest>;
export const TaskManifestJson = fromRow(TaskManifest);

// The folder's JSON is written in snake_case, as the database's is; fromRow reads it back.
export function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(v)]));
}

// The de-identified record, shown before anything is built.
export const TaskPreview = z.object({
  reasons: z.array(ExportReason),
  parts: z.array(z.object({ path: z.string(), text: z.string() })),
  evidence: z.array(z.object({ path: z.string(), was: z.string(), role: RunFileRole, kind: FileKind, treatment: EvidenceTreatment, bytes: z.number(), sourceSha256: Sha256, excerpt: z.string().nullable() })),
  leftOut: z.array(z.object({ was: z.string(), kind: FileKind, reason: LeftOutReason })),
  counts: z.object({ people: z.number(), samples: z.number(), emails: z.number(), replacements: z.number() }),
  excluded: z.array(z.string()),
});
export type TaskPreview = z.infer<typeof TaskPreview>;

export type BuildOutcome = { kind: "built"; task: RunTask; id: string } | { kind: "blocked"; reasons: ExportReason[] };
export const BuildOutcomeWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("built"), task: RunTask, id: z.uuid() }),
  z.object({ kind: z.literal("blocked"), reasons: z.array(ExportReason) }),
]) satisfies z.ZodType<BuildOutcome, unknown>;

export const PersonChoice = z.object({ id: PersonId, name: z.string() });
export type PersonChoice = z.infer<typeof PersonChoice>;
export const ExperimentChoice = z.object({ id: ExperimentId, name: z.string() });

export function taskHref(runId: RunId): string {
  return `/runs/${runId}/export`;
}
export function taskDownloadHref(runId: RunId, exportId: string): string {
  return `/api/run-records/${runId}/export/${exportId}`;
}
