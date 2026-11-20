import { z } from "zod";
import { FileKind, IsoDate, LabelOutcome } from "./domain";
import { ExperimentId, LocationId, PersonId, ProtocolId, ProtocolVersionId, RunId, Sha256, UserId } from "./ids";

// The run record (decisions.md, "the run record: foundation"): one attempt at an experiment,
// with files as its evidence. These are the shapes every part of it shares. The foundation
// owns this file; a slice adds what only it needs in its own module.

export const RUN_STATUSES = ["worked", "failed", "odd"] as const;
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;

// The words for each answer where it's picked. Each has a line under it because "odd" is the
// one a new student won't guess.
export const STATUS_CHOICES = [
  { status: "worked", label: "Worked", hint: "It did what you expected." },
  { status: "failed", label: "Failed", hint: "It didn't work." },
  { status: "odd", label: "Odd", hint: "It ran, but the result is strange and you're not sure why yet." },
] as const satisfies readonly { status: RunStatus; label: string; hint: string }[];

export function statusLabel(status: RunStatus | null): string {
  return STATUS_CHOICES.find((c) => c.status === status)?.label ?? "Not marked yet";
}

export const RunFileRole = z.enum(["evidence", "shared_control", "standard"]);
export type RunFileRole = z.infer<typeof RunFileRole>;

export const ROLE_LABELS = {
  evidence: "This run's own file",
  shared_control: "A control shared with other runs",
  standard: "A standard shared with other runs",
} as const satisfies Record<RunFileRole, string>;

export const ConfirmMethod = z.enum(["control", "repeat", "pi_opinion"]);
export type ConfirmMethod = z.infer<typeof ConfirmMethod>;

export const RunFix = z.enum(["yes", "no", "not_sure"]);
export type RunFix = z.infer<typeof RunFix>;

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");
const Named = <T extends z.ZodType>(id: T) => z.object({ id, name: z.string() });

// A run as another points at it.
export const RunRef = z.object({ id: RunId, title: z.string(), startedOn: IsoDate.nullable(), status: RunStatus.nullable() });
export type RunRef = z.infer<typeof RunRef>;

export const RunFile = z.object({
  sha256: Sha256,
  role: RunFileRole,
  name: z.string(),
  originalName: z.string().nullable(),
  fileKind: FileKind,
  size: z.number(),
  // Where the file lives in the lab now; null once it's gone from the lab's folder.
  locationId: LocationId.nullable(),
  // Its own bytes are in our store, so the original opens exactly as it was read.
  kept: z.boolean(),
  // What the file's label reads as its outcome. A hint beside the file, never the run's status.
  fileSays: LabelOutcome.nullable(),
});
export type RunFile = z.infer<typeof RunFile>;

// Slice A writes these (set_suspected_cause, confirm_cause, attest_cause, set_failure_type).
export const FailureFields = z.object({
  suspectedCause: z.string().nullable(),
  suspectedBy: UserId.nullable(),
  confirmedCause: z.string().nullable(),
  confirmedBy: Named(PersonId).nullable(),
  confirmMethod: ConfirmMethod.nullable(),
  confirmNote: z.string().nullable(),
  confirmRun: RunRef.nullable(),
  confirmSha256: Sha256.nullable(),
  confirmedAt: Timestamp.nullable(),
  confirmRecordedBy: UserId.nullable(),
  confirmerAttestedAt: Timestamp.nullable(),
  taxonomyVersion: z.number().int().nullable(),
  technique: z.string().nullable(),
  failedStep: z.string().nullable(),
  causeCategory: z.string().nullable(),
});
export type FailureFields = z.infer<typeof FailureFields>;

// Slice D writes these when a debrief is approved: each is the scientist's own answer.
export const DebriefFields = z.object({
  aim: z.string().nullable(),
  expectedSeen: z.string().nullable(),
  howFound: z.string().nullable(),
  whatChanged: z.string().nullable(),
  fixWorked: RunFix.nullable(),
  whoElse: z.string().nullable(),
  debriefedAt: Timestamp.nullable(),
});
export type DebriefFields = z.infer<typeof DebriefFields>;

// Slice B writes these (set_run_plan, save_as_run).
export const PlanFields = z.object({
  planned: z.object({ versionId: ProtocolVersionId, protocolId: ProtocolId, title: z.string(), version: z.number().int() }).nullable(),
  asRun: z.object({ body: z.string(), basedOn: ProtocolVersionId.nullable(), by: UserId.nullable(), at: Timestamp }).nullable(),
});
export type PlanFields = z.infer<typeof PlanFields>;

export const RunRecord = z.object({
  id: RunId,
  title: z.string(),
  startedOn: IsoDate.nullable(),
  endedOn: IsoDate.nullable(),
  experiment: Named(ExperimentId).nullable(),
  person: Named(PersonId).nullable(),
  status: RunStatus.nullable(),
  // Null with a status set: read once from the first file's label when the run was made.
  statusBy: UserId.nullable(),
  statusAt: Timestamp.nullable(),
  createdBy: UserId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  retryOf: RunRef.nullable(),
  retriedIn: z.array(RunRef),
  // A run this one might retry, from a repeat link between their files. Offered, never applied.
  retryHint: RunRef.nullable(),
  files: z.array(RunFile),
  failure: FailureFields,
  debrief: DebriefFields,
  plan: PlanFields,
  // Slice C's switch. Off unless a person turned it on.
  share: z.boolean(),
});
export type RunRecord = z.infer<typeof RunRecord>;

// A row of the runs list.
export const RunRow = z.object({
  id: RunId,
  title: z.string(),
  startedOn: IsoDate.nullable(),
  status: RunStatus.nullable(),
  experiment: z.string().nullable(),
  person: z.string().nullable(),
  files: z.number().int(),
  retryOf: RunRef.nullable(),
  confirmed: z.boolean(),
  technique: z.string().nullable(),
  failedStep: z.string().nullable(),
  causeCategory: z.string().nullable(),
});
export type RunRow = z.infer<typeof RunRow>;

// "Turn these into runs?": files a person already vouched for that say how they went.
export const RunSuggestion = z.object({
  key: z.string(),
  shas: z.array(Sha256).min(1),
  title: z.string(),
  date: IsoDate.nullable(),
  fileSays: LabelOutcome,
});
export type RunSuggestion = z.infer<typeof RunSuggestion>;

// The run a file belongs to: the newest run it is evidence of.
export const FileRun = z.object({ sha256: Sha256, runId: RunId, title: z.string(), status: RunStatus.nullable() });
export type FileRun = z.infer<typeof FileRun>;

// The failure list (failure_terms), read from the database; the app keeps no copy.
export const FailureTerm = z.object({ version: z.number().int(), code: z.string(), label: z.string(), hint: z.string().nullable(), position: z.number().int() });
export type FailureTerm = z.infer<typeof FailureTerm>;

// Database rows and JSON come in snake_case; the app's shapes are camelCase. One schema per
// shape: a row goes through `fromRow`, which renames the keys and then parses.
function camelKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()), camelKeys(v)]));
}
export const fromRow = <T extends z.ZodType>(schema: T) => z.unknown().transform(camelKeys).pipe(schema);

export const RunJson = fromRow(RunRecord);
export const RunRowsJson = fromRow(z.array(RunRow));
export const RunRefsJson = fromRow(z.array(RunRef));
export const RunSuggestionsJson = fromRow(z.array(RunSuggestion));
export const FileRunsJson = fromRow(z.array(FileRun));

// ---- What the browser sends.

export const MAX_RUN_FILES = 50;

export const RunFieldsDraft = z.object({
  title: z.string().trim().min(1, "Give the run a name.").max(200).optional(),
  startedOn: IsoDate.nullable().optional(),
  endedOn: IsoDate.nullable().optional(),
  experimentId: ExperimentId.nullable().optional(),
  personId: PersonId.nullable().optional(),
});
export type RunFieldsDraft = z.infer<typeof RunFieldsDraft>;

export const NewRunFields = RunFieldsDraft.extend({ status: RunStatus.nullable().optional(), retryOf: RunId.nullable().optional() });
export type NewRunFields = z.infer<typeof NewRunFields>;

export const CreateRunRequest = z.object({
  shas: z.array(Sha256).min(1, "Pick at least one file.").max(MAX_RUN_FILES, `A run takes up to ${MAX_RUN_FILES} files at a time.`),
  fields: NewRunFields.default({}),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const SetStatusRequest = z.object({ status: RunStatus.nullable(), clearCauses: z.boolean().default(false) });
export const AddFilesRequest = z.object({ shas: z.array(Sha256).min(1).max(MAX_RUN_FILES), role: RunFileRole.default("evidence") });
export const RemoveFileRequest = z.object({ sha256: Sha256 });
export const LinkRetryRequest = z.object({ retryOf: RunId.nullable() });

export const RunListFilter = z.object({
  status: z.enum([...RUN_STATUSES, "none"]).optional(),
  technique: z.string().max(60).optional(),
  step: z.string().max(60).optional(),
  cause: z.string().max(60).optional(),
  experimentId: ExperimentId.optional(),
});
export type RunListFilter = z.infer<typeof RunListFilter>;

export const RUNS_PAGE = 50;

// A status change comes back saved, or asks first: the run has a cause written down, and
// leaving failed or odd would remove it.
export type StatusOutcome = { kind: "saved"; run: RunRecord } | { kind: "has_causes" };
export const StatusOutcomeWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("saved"), run: RunRecord }),
  z.object({ kind: z.literal("has_causes") }),
]) satisfies z.ZodType<StatusOutcome, unknown>;

// The fields of create_run and edit_run as the database names them; a key left out is left alone.
const FIELD_COLUMNS = {
  title: "title",
  startedOn: "started_on",
  endedOn: "ended_on",
  experimentId: "experiment_id",
  personId: "person_id",
  status: "status",
  retryOf: "retry_of",
} as const satisfies Record<keyof NewRunFields, string>;

export function fieldArgs(fields: NewRunFields): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of Object.keys(FIELD_COLUMNS) as (keyof NewRunFields)[]) {
    const value = fields[key];
    if (value !== undefined) out[FIELD_COLUMNS[key]] = value;
  }
  return out;
}

export function filterArgs(filter: RunListFilter): Record<string, string> {
  const { experimentId, ...rest } = filter;
  return { ...rest, ...(experimentId === undefined ? {} : { experiment_id: experimentId }) };
}

// A database error from a run function, as the browser should see it. BL906 (a status change
// that would remove a cause) isn't here: it's an answer, not a failure (StatusOutcome).
export type RunFailure = { status: number; message: string };
const FAILURES: Readonly<Record<string, RunFailure>> = {
  "42501": { status: 403, message: "That run belongs to another lab." },
  BL901: { status: 400, message: "One of those files isn't in the lab any more. Untick it and try again." },
  BL902: { status: 400, message: "A run keeps at least one file. Add another before taking this one out." },
  BL903: { status: 400, message: "That run is already a retry of this one, so it can't be the other way round too." },
  BL904: { status: 400, message: "A voice recording can't be one of a run's files. Untick it and try again." },
  BL905: { status: 400, message: "That experiment or person isn't in this lab." },
  BL907: { status: 404, message: "That run doesn't exist any more." },
  BL908: { status: 400, message: "A run needs a name and 1 to 50 files." },
  "23514": { status: 400, message: "Those dates don't fit together. A run ends on or after the day it started." },
};
export function runFailure(error: { code?: string }): RunFailure {
  return FAILURES[error.code ?? ""] ?? { status: 500, message: "We couldn't save that. Try again." };
}
