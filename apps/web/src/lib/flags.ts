import { z } from "zod";
import { CheckKind, CheckRange, type Usefulness } from "./checks";
import { FileLocation, SourceKind } from "./domain";
import { CheckId, ColumnId, FlagId, LocationId, ProtocolId, ProtocolVersionId, Sha256, SourceId, UserId } from "./ids";

// Flags and check results as the worker records them (db/migrations/0018_checks.sql).

export const REVIEWS = ["useful", "wrong", "known_issue"] as const;
export const Review = z.enum(REVIEWS);
export type Review = z.infer<typeof Review>;

export const REVIEW_NAMES = { useful: "Useful", wrong: "Wrong", known_issue: "Known issue" } satisfies Record<Review, string>;

export const REVIEW_NOTE_MAX = 500;

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");

// Rows of the parsed table as [first, last] pairs, 0-based (row_spans in SQL).
const Spans = z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]));
export type Spans = z.infer<typeof Spans>;

// The newest live place the file lives (flag_file_json), or null once it's gone from the lab.
export type FlagFileRef = { location: FileLocation; cleanName: string | null };

const FileRefRow = z.object({ location: FileLocation, cleanName: z.string().nullable() }).nullable();

const FileRefWire = z
  .object({
    location: z.object({
      id: LocationId,
      sourceId: SourceId,
      sourceKind: SourceKind,
      path: z.string(),
      originalName: z.string(),
      modifiedAt: z.string(),
    }),
    cleanName: z.string().nullable(),
  })
  .nullable() satisfies z.ZodType<FlagFileRef | null>;

export type Cells = { sha256: Sha256; sheet: string; columns: ColumnId[]; rows: Spans; file: FlagFileRef | null };

export type FlagState = { kind: "open" } | { kind: "cleared"; at: string; reason: string };

export type FlagAnswer = { review: Review; note: string | null; by: UserId | null; at: string };

export type Flag = {
  id: FlagId;
  protocolId: ProtocolId;
  protocolTitle: string;
  protocolVersion: number;
  protocolVersionId: ProtocolVersionId;
  checkId: CheckId;
  checkName: string;
  kind: CheckKind;
  observed: number;
  expected: CheckRange;
  unit: string | null;
  source: Cells;
  // Where the day's controls were read, for a control check (it may be the same file).
  control: Cells | null;
  raisedAt: string;
  state: FlagState;
  answer: FlagAnswer | null;
};

// lab_flags() rows, as PostgREST serializes them.
export const FlagRow = z
  .object({
    id: FlagId,
    sha256: Sha256,
    protocol_id: ProtocolId,
    protocol_title: z.string(),
    protocol_version: z.number().int().positive(),
    protocol_version_id: ProtocolVersionId,
    check_id: CheckId,
    check_name: z.string().nullable(),
    kind: CheckKind,
    observed: z.number(),
    expected: CheckRange,
    unit: z.string().nullable(),
    source_sheet: z.string(),
    source_columns: z.array(ColumnId).min(1),
    source_rows: Spans.min(1),
    control_sha256: Sha256.nullable(),
    control_sheet: z.string().nullable(),
    control_columns: z.array(ColumnId).nullable(),
    control_rows: Spans.nullable(),
    raised_at: Timestamp,
    cleared_at: Timestamp.nullable(),
    cleared_reason: z.string().nullable(),
    review: Review.nullable(),
    review_note: z.string().nullable(),
    reviewed_by: UserId.nullable(),
    reviewed_at: Timestamp.nullable(),
    file: FileRefRow,
    control_file: FileRefRow,
  })
  .transform((r, ctx): Flag => {
    const control =
      r.control_sha256 !== null && r.control_sheet !== null && r.control_columns !== null && r.control_rows !== null
        ? { sha256: r.control_sha256, sheet: r.control_sheet, columns: r.control_columns, rows: r.control_rows, file: r.control_file }
        : null;
    if ((r.kind === "control") !== (control !== null)) ctx.addIssue({ code: "custom", message: "a control flag names its controls" });
    return {
      id: r.id,
      protocolId: r.protocol_id,
      protocolTitle: r.protocol_title,
      protocolVersion: r.protocol_version,
      protocolVersionId: r.protocol_version_id,
      checkId: r.check_id,
      checkName: r.check_name ?? "A check",
      kind: r.kind,
      observed: r.observed,
      expected: r.expected,
      unit: r.unit,
      source: { sha256: r.sha256, sheet: r.source_sheet, columns: r.source_columns, rows: r.source_rows, file: r.file },
      control,
      raisedAt: r.raised_at,
      state:
        r.cleared_at === null ? { kind: "open" } : { kind: "cleared", at: r.cleared_at, reason: r.cleared_reason ?? "It was cleared." },
      answer:
        r.review === null || r.reviewed_at === null
          ? null
          : { review: r.review, note: r.review_note, by: r.reviewed_by, at: r.reviewed_at },
    };
  });
export const FlagRows = z.array(FlagRow);

const CellsWire = z.object({
  sha256: Sha256,
  sheet: z.string(),
  columns: z.array(ColumnId),
  rows: Spans,
  file: FileRefWire,
}) satisfies z.ZodType<Cells>;

export const FlagWire = z.object({
  id: FlagId,
  protocolId: ProtocolId,
  protocolTitle: z.string(),
  protocolVersion: z.number().int().positive(),
  protocolVersionId: ProtocolVersionId,
  checkId: CheckId,
  checkName: z.string(),
  kind: CheckKind,
  observed: z.number(),
  expected: CheckRange,
  unit: z.string().nullable(),
  source: CellsWire,
  control: CellsWire.nullable(),
  raisedAt: Timestamp,
  state: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("open") }),
    z.object({ kind: z.literal("cleared"), at: Timestamp, reason: z.string() }),
  ]),
  answer: z.object({ review: Review, note: z.string().nullable(), by: UserId.nullable(), at: Timestamp }).nullable(),
}) satisfies z.ZodType<Flag>;

export function isAnswered(flag: Flag): boolean {
  return flag.answer !== null;
}

// The Flags list: open flags waiting for an answer first, newest first, then answered ones.
export function queueOrder(flags: readonly Flag[]): { waiting: Flag[]; answered: Flag[] } {
  const open = flags.filter((f) => f.state.kind === "open").toSorted((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  return { waiting: open.filter((f) => !isAnswered(f)), answered: open.filter(isAnswered) };
}

export function flagHref(id: FlagId): string {
  return `/flags/${id}`;
}

export function fileName(cells: Cells): string {
  return cells.file?.cleanName ?? cells.file?.location.originalName ?? "A file no longer in the lab";
}

// "rows 1–8", "row 41", "rows 1–3, 5".
export function rowsText(spans: Spans): string {
  const parts = spans.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}–${b + 1}`));
  const one = spans.length === 1 && spans[0]?.[0] === spans[0]?.[1];
  return `${one ? "row" : "rows"} ${parts.join(", ")}`;
}

export function inSpans(spans: Spans, row: number): boolean {
  return spans.some(([a, b]) => row >= a && row <= b);
}

// POST /api/flags/<id>: someone's answer.
export const ReviewRequest = z.object({
  review: Review,
  note: z
    .string()
    .trim()
    .max(REVIEW_NOTE_MAX, `Keep the note under ${REVIEW_NOTE_MAX} characters.`)
    .transform((s) => (s === "" ? null : s))
    .nullable(),
});
export type ReviewRequest = z.input<typeof ReviewRequest>;

export function reviewArgs(id: FlagId, req: z.output<typeof ReviewRequest>) {
  return { p_flag_id: id, p_review: req.review, p_note: req.note };
}

export const ReviewRows = z
  .tuple([
    z.object({
      id: FlagId,
      review: Review,
      review_note: z.string().nullable(),
      reviewed_by: UserId.nullable(),
      reviewed_at: Timestamp,
    }),
  ])
  .transform(([r]): FlagAnswer => ({ review: r.review, note: r.review_note, by: r.reviewed_by, at: r.reviewed_at }));

export const FlagAnswerWire = z.object({
  review: Review,
  note: z.string().nullable(),
  by: UserId.nullable(),
  at: Timestamp,
}) satisfies z.ZodType<FlagAnswer>;

// file_checks() rows: how each check that reaches a file came out.
export type FileCheck = {
  protocolId: ProtocolId;
  protocolTitle: string;
  protocolVersion: number;
  checkId: CheckId;
  checkName: string;
  kind: CheckKind;
  expected: CheckRange;
  unit: string | null;
  outcome: { kind: "passed"; observed: number } | { kind: "flagged"; observed: number; flagId: FlagId | null } | { kind: "couldnt"; reason: string };
};

export const FileCheckRows = z.array(
  z
    .object({
      protocol_id: ProtocolId,
      protocol_title: z.string(),
      protocol_version: z.number().int().positive(),
      check_id: CheckId,
      check_name: z.string(),
      kind: CheckKind,
      outcome: z.enum(["passed", "flagged", "couldnt"]),
      observed: z.number().nullable(),
      expected: CheckRange,
      unit: z.string().nullable(),
      reason: z.string().nullable(),
      flag_id: FlagId.nullable(),
    })
    .transform((r, ctx): FileCheck => {
      const base = {
        protocolId: r.protocol_id,
        protocolTitle: r.protocol_title,
        protocolVersion: r.protocol_version,
        checkId: r.check_id,
        checkName: r.check_name,
        kind: r.kind,
        expected: r.expected,
        unit: r.unit,
      };
      if (r.outcome === "couldnt") return { ...base, outcome: { kind: "couldnt", reason: r.reason ?? "It couldn't be checked." } };
      if (r.observed === null) {
        ctx.addIssue({ code: "custom", message: "a checked value has a number" });
        return z.NEVER;
      }
      return {
        ...base,
        outcome: r.outcome === "passed" ? { kind: "passed", observed: r.observed } : { kind: "flagged", observed: r.observed, flagId: r.flag_id },
      };
    }),
);

const FileCheckWire = z.object({
  protocolId: ProtocolId,
  protocolTitle: z.string(),
  protocolVersion: z.number().int().positive(),
  checkId: CheckId,
  checkName: z.string(),
  kind: CheckKind,
  expected: CheckRange,
  unit: z.string().nullable(),
  outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("passed"), observed: z.number() }),
    z.object({ kind: z.literal("flagged"), observed: z.number(), flagId: FlagId.nullable() }),
    z.object({ kind: z.literal("couldnt"), reason: z.string() }),
  ]),
}) satisfies z.ZodType<FileCheck>;

// GET /api/flags?sha256=: a file's checks, its open flags, and whether a check is on its way.
export const FileChecksWire = z.object({ checking: z.boolean(), checks: z.array(FileCheckWire), flags: z.array(FlagWire) });
export type FileChecks = z.infer<typeof FileChecksWire>;

// file_flag_marks() rows: open flags per file, which turn its row amber.
export const FlagMarkRows = z.array(z.object({ sha256: Sha256, flags: z.number().int().positive() }));
export const FlagMarksWire = z.record(z.string(), z.number().int().nonnegative());

export const FlagQueueCount = z.number().int().nonnegative();

// check_usefulness() rows, keyed "<protocol id> <check id>".
export const UsefulnessRows = z
  .array(
    z.object({
      protocol_id: ProtocolId,
      check_id: CheckId,
      flags: z.number().int().nonnegative(),
      useful: z.number().int().nonnegative(),
      wrong: z.number().int().nonnegative(),
      known_issue: z.number().int().nonnegative(),
    }),
  )
  .transform((rows) =>
    Object.fromEntries(
      rows.map((r) => [usefulnessKey(r.protocol_id, r.check_id), { flags: r.flags, useful: r.useful, wrong: r.wrong, knownIssue: r.known_issue } satisfies Usefulness]),
    ),
  );
export type UsefulnessByCheck = Readonly<Record<string, Usefulness>>;

export function usefulnessKey(protocolId: ProtocolId, checkId: CheckId): string {
  return `${protocolId} ${checkId}`;
}

// The codes 0018_checks.sql raises for flags.
export function flagFailure(error: { code?: string }): { status: number; message: string } {
  switch (error.code) {
    case "BL107":
      return { status: 404, message: "This flag isn't in your lab." };
    case "22023":
      return { status: 400, message: "Pick useful, wrong or known issue." };
    case "23514":
      return { status: 400, message: `Keep the note under ${REVIEW_NOTE_MAX} characters.` };
    case "42501":
      return { status: 403, message: "You're not a member of this lab." };
    default:
      return { status: 500, message: "We couldn't save that answer. Try again." };
  }
}
