import { z } from "zod";
import { CorrectionId, ExperimentId, LabId, LocationId, PersonId, Sha256, SourceId, UserId } from "./ids";
import { ProtocolHitWire } from "./protocols";

// Mirrors of the enums in db/migrations/0001_core.sql.
export const FILE_KINDS = ["pdf", "spreadsheet", "document", "text", "image", "other", "audio", "video"] as const;
export const FileKind = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKind>;

// The kinds the worker extracts text from, so a page can start from one.
export function isTextBearing(kind: FileKind): boolean {
  return kind === "pdf" || kind === "document" || kind === "text" || kind === "spreadsheet";
}

export const MemberRole = z.enum(["admin", "member"]);
export type MemberRole = z.infer<typeof MemberRole>;

export const SourceKind = z.enum(["dropbox", "local", "upload", "instrument", "import"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const AuditAction = z.enum([
  "lab.create",
  "source.connect",
  "source.set_folder",
  "scan.request",
  "member.invite",
  "search",
  "preview.view",
  "protocol.create",
  "protocol.save",
  "protocol.archive",
  "protocol.link_file",
  "protocol.unlink_file",
  "source.disconnect",
  "lab.delete",
  "protocol.export",
  "file.upload",
  "file.download",
  "instrument.create",
  "instrument.pair",
  "instrument.revoke",
  "chart.create",
  "chart.save",
  "chart.delete",
  "calendar.create",
  "calendar.save",
  "calendar.delete",
  "check.save",
  "flag.review",
  "question.ask",
  "suggestion.create",
  "suggestion.approve",
  "suggestion.dismiss",
  "layout.create",
  "layout.save",
  "layout.delete",
  "note.join",
  "note.split",
  "note.keep",
  "note.remove_page",
]);
export type AuditAction = z.infer<typeof AuditAction>;

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");

export const FileLocation = z
  .object({
    id: LocationId,
    source_id: SourceId,
    source_kind: SourceKind,
    path: z.string(),
    original_name: z.string(),
    modified_at: Timestamp,
  })
  .transform((l) => ({
    id: l.id,
    sourceId: l.source_id,
    sourceKind: l.source_kind,
    path: l.path,
    originalName: l.original_name,
    modifiedAt: l.modified_at,
  }));
export type FileLocation = z.infer<typeof FileLocation>;

const FileLocationWire = z.object({
  id: LocationId,
  sourceId: SourceId,
  sourceKind: SourceKind,
  path: z.string(),
  originalName: z.string(),
  modifiedAt: Timestamp,
}) satisfies z.ZodType<FileLocation>;

// Mirrors label_status in db/migrations/0004_labels.sql.
export const LabelStatus = z.enum(["suggested", "check", "needs_look", "accepted", "corrected"]);
export type LabelStatus = z.infer<typeof LabelStatus>;

export const IsoDate = z.iso.date();

export type ExperimentRef = { id: ExperimentId; name: string };
export type PersonRef = { id: PersonId; name: string };

// Mirrors label_outcome in db/migrations/0025_smart_labels.sql. Null for files that aren't runs.
export const LabelOutcome = z.enum(["worked", "failed", "repeat", "final", "unclear"]);
export type LabelOutcome = z.infer<typeof LabelOutcome>;

// Mirrors note_kind: what sort of file it is, which decides the facts a label pulls out.
export const NoteKind = z.enum([
  "experiment_notes",
  "meeting_notes",
  "reading_summary",
  "lecture",
  "protocol",
  "data",
  "image",
  "other",
]);
export type NoteKind = z.infer<typeof NoteKind>;

// One key fact behind a label (label_conditions_ok in 0025): drug A 0.1–100 µM, 37 °C, plate 3.
// Conditions, samples and materials for a run; attendees and decisions for meeting notes. The
// charts work can read a file's conditions from here (a sample layout from "drug A, 5
// concentrations, 3 wells each").
export const ConditionKind = z.enum(["condition", "sample", "material", "attendee", "decision"]);
export type ConditionKind = z.infer<typeof ConditionKind>;
export const LabelCondition = z.object({
  kind: ConditionKind,
  what: z.string().min(1).max(80),
  value: z.string().min(1).max(80).nullable(),
  unit: z.string().min(1).max(20).nullable(),
});
export type LabelCondition = z.infer<typeof LabelCondition>;

// What a value reads as when the file doesn't show it clearly. Binary never guesses one.
export const UNCLEAR = "[unclear]";

// One short question for a voice note that left its experiment or date open.
export const FollowUp = z.object({
  field: z.enum(["experiment", "date"]),
  question: z.string(),
  choices: z.array(z.object({ label: z.string(), value: z.string() })).min(1),
});
export type FollowUp = z.infer<typeof FollowUp>;

export const NoteId = z.uuid().brand<"NoteId">();
export type NoteId = z.infer<typeof NoteId>;
export const NotePageRole = z.enum(["setup", "readings", "reflection", "other"]);
export type NotePageRole = z.infer<typeof NotePageRole>;
export type NotePage = { sha256: Sha256; position: number; role: NotePageRole; hasPreview: boolean; location: FileLocation | null };
// The note a file is a page of: every page in order, and which one this file is.
export type NoteInfo = {
  id: NoteId;
  state: "suggested" | "confirmed";
  reason: string;
  position: number;
  pages: [NotePage, ...NotePage[]];
};

// Everything on a label besides its name that a correction sets.
export type LabelDetails = {
  date: string | null;
  experiment: ExperimentRef | null;
  person: PersonRef | null;
  instrument: string | null;
  tags: string[];
  outcome: LabelOutcome | null;
  summary: string | null;
  conditions: LabelCondition[];
  noteKind: NoteKind | null;
};

// Another labeled file as a label points at it: a run this one repeats, or a repeat of it.
export const FileRef = z.object({ sha256: Sha256, name: z.string() });
export type FileRef = z.infer<typeof FileRef>;

// What Binary adds that a person reads but doesn't set directly: two other titles while it's
// unsure, what it couldn't read, a voice note's question (null once skipped), the note the file
// belongs to, and the runs it repeats or that repeat it.
export type LabelHints = {
  alternatives: string[];
  unclear: string[];
  followUp: FollowUp | null;
  note: NoteInfo | null;
  repeatOf: FileRef | null;
  repeatedIn: FileRef[];
};

// "Needs a look" is the one state with no name to show.
export type Label = LabelDetails & LabelHints & { confidence: number } & (
    | { status: "needs_look"; cleanName: null }
    | { status: Exclude<LabelStatus, "needs_look">; cleanName: string }
  );

// A label with none of 0025's fields set: for labels built in code (fixtures, tests).
export const PLAIN_LABEL: Pick<LabelDetails, "outcome" | "summary" | "conditions" | "noteKind"> & LabelHints = {
  outcome: null,
  summary: null,
  conditions: [],
  noteKind: null,
  alternatives: [],
  unclear: [],
  followUp: null,
  note: null,
  repeatOf: null,
  repeatedIn: [],
};

export function needsCheck(label: Label | null): boolean {
  return label?.status === "check";
}

const ExperimentRefSchema = z.object({ id: ExperimentId, name: z.string() });
const PersonRefSchema = z.object({ id: PersonId, name: z.string() });

const NotePageRow = z
  .object({ sha256: Sha256, position: z.number().int().positive(), role: NotePageRole, has_preview: z.boolean(), location: FileLocation.nullable() })
  .transform((p): NotePage => ({ sha256: p.sha256, position: p.position, role: p.role, hasPreview: p.has_preview, location: p.location }));
const NotePageWire = z.object({
  sha256: Sha256,
  position: z.number().int().positive(),
  role: NotePageRole,
  hasPreview: z.boolean(),
  location: FileLocationWire.nullable(),
}) satisfies z.ZodType<NotePage>;
const noteFields = { id: NoteId, state: z.enum(["suggested", "confirmed"]), reason: z.string(), position: z.number().int().positive() };
const NoteRow = z.object({ ...noteFields, pages: z.tuple([NotePageRow], NotePageRow) });
const NoteWire = z.object({ ...noteFields, pages: z.tuple([NotePageWire], NotePageWire) }) satisfies z.ZodType<NoteInfo>;

// The fields 0025 added default to empty, so a label read before that (or a fixture) parses.
const smartFields = {
  outcome: LabelOutcome.nullable().default(null),
  summary: z.string().nullable().default(null),
  conditions: z.array(LabelCondition).default([]),
  alternatives: z.array(z.string()).default([]),
  unclear: z.array(z.string()).default([]),
};

const labelFields = {
  status: LabelStatus,
  date: IsoDate.nullable(),
  experiment: ExperimentRefSchema.nullable(),
  person: PersonRefSchema.nullable(),
  instrument: z.string().nullable(),
  tags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  ...smartFields,
};

type FlatLabel = LabelDetails & LabelHints & { status: LabelStatus; cleanName: string | null; confidence: number };

function toLabel(flat: FlatLabel, ctx: z.RefinementCtx): Label {
  const { status, cleanName, ...rest } = flat;
  if (status === "needs_look") {
    if (cleanName !== null) ctx.addIssue({ code: "custom", message: "a needs_look label has no name" });
    return { ...rest, status, cleanName: null };
  }
  if (cleanName === null) {
    ctx.addIssue({ code: "custom", message: `a ${status} label needs a name` });
    return z.NEVER;
  }
  return { ...rest, status, cleanName };
}

// label_json() as PostgREST and to_jsonb serialize it.
export const LabelRow = z
  .object({
    ...labelFields,
    clean_name: z.string().nullable(),
    note_kind: NoteKind.nullable().default(null),
    follow_up: FollowUp.nullable().default(null),
    note: NoteRow.nullable().default(null),
    repeat_of: FileRef.nullable().default(null),
    repeated_in: z.array(FileRef).default([]),
  })
  .transform(({ clean_name, note_kind, follow_up, repeat_of, repeated_in, ...r }, ctx) =>
    toLabel({ ...r, cleanName: clean_name, noteKind: note_kind, followUp: follow_up, repeatOf: repeat_of, repeatedIn: repeated_in }, ctx),
  );

export const LabelWire = z
  .object({
    ...labelFields,
    cleanName: z.string().nullable(),
    noteKind: NoteKind.nullable().default(null),
    followUp: FollowUp.nullable().default(null),
    note: NoteWire.nullable().default(null),
    repeatOf: FileRef.nullable().default(null),
    repeatedIn: z.array(FileRef).default([]),
  })
  .transform((r, ctx) => toLabel(r, ctx)) satisfies z.ZodType<Label, unknown>;

export type MatchReason = "words" | "meaning";

function matchReasons(ranks: { keyword_rank: number | null; vector_rank: number | null }): MatchReason[] {
  const reasons: MatchReason[] = [];
  if (ranks.keyword_rank !== null) reasons.push("words");
  if (ranks.vector_rank !== null) reasons.push("meaning");
  return reasons;
}

// One file (one sha256) as the UI shows it: a search hit or a recent file.
// `locations[0]` is the most recently modified place it lives.
export type FileHit = {
  sha256: Sha256;
  fileKind: FileKind;
  mime: string;
  size: number;
  hasPreview: boolean;
  snippet: string | null;
  locations: [FileLocation, ...FileLocation[]];
  matchedBy: MatchReason[];
  // For a note found by a word on one of its pages, that page (1 is the first); the row opens there.
  matchedPage?: number | null;
  // Null until the labeler has seen the file.
  label: Label | null;
};

const Rank = z.number().int().positive().nullable();

export const SearchFilesRow = z
  .object({
    sha256: Sha256,
    score: z.number(),
    keyword_rank: Rank,
    vector_rank: Rank,
    snippet: z.string().nullable(),
    file_kind: FileKind,
    mime: z.string(),
    size: z.number().int().nonnegative(),
    has_preview: z.boolean(),
    locations: z.tuple([FileLocation], FileLocation),
    label: LabelRow.nullable(),
    matched_page: z.number().int().positive().nullable().default(null),
  })
  .transform((r): FileHit => ({
    sha256: r.sha256,
    fileKind: r.file_kind,
    mime: r.mime,
    size: r.size,
    hasPreview: r.has_preview,
    snippet: r.snippet,
    locations: r.locations,
    matchedBy: matchReasons(r),
    label: r.label,
    matchedPage: r.matched_page,
  }));
export const SearchFilesRows = z.array(SearchFilesRow);

export type LabeledFileHit = FileHit & { label: Label };

export const NeedsLookRow = z
  .object({
    sha256: Sha256,
    file_kind: FileKind,
    mime: z.string(),
    size: z.number().int().nonnegative(),
    has_preview: z.boolean(),
    snippet: z.string().nullable(),
    locations: z.tuple([FileLocation], FileLocation),
    label: LabelRow,
  })
  .transform((r): LabeledFileHit => ({
    sha256: r.sha256,
    fileKind: r.file_kind,
    mime: r.mime,
    size: r.size,
    hasPreview: r.has_preview,
    snippet: r.snippet,
    locations: r.locations,
    matchedBy: [],
    label: r.label,
  }));
export const NeedsLookRows = z.array(NeedsLookRow);

export const FileLabelRows = z.array(z.object({ sha256: Sha256, label: LabelRow }));
export const FileLabelsWire = z.array(z.object({ sha256: Sha256, label: LabelWire }));
export type FileLabel = z.infer<typeof FileLabelsWire>[number];

// correct_label and undo_correction both return the correction's id and the label after it.
export const CorrectionRows = z
  .tuple([z.object({ correction_id: CorrectionId, label: LabelRow })])
  .transform(([r]) => ({ correctionId: r.correction_id, label: r.label }));
export const CorrectionWire = z.object({ correctionId: CorrectionId, label: LabelWire });
export type Correction = z.infer<typeof CorrectionWire>;

export const NeedsLookCount = z.number().int().nonnegative();

const Aliases = z.array(z.string());

export const ExperimentRows = z.array(
  z.object({ id: ExperimentId, name: z.string(), aliases: Aliases }),
);
export type Experiment = z.infer<typeof ExperimentRows>[number];

export const PersonRows = z.array(
  z
    .object({ id: PersonId, display_name: z.string(), aliases: Aliases })
    .transform((p) => ({ id: p.id, name: p.display_name, aliases: p.aliases })),
);
export type Person = z.infer<typeof PersonRows>[number];

export const KeywordReason = z.enum(["embed_timeout", "embed_error", "embed_unconfigured"]);
export type KeywordReason = z.infer<typeof KeywordReason>;


export const FileHitWire = z.object({
  sha256: Sha256,
  fileKind: FileKind,
  mime: z.string(),
  size: z.number(),
  hasPreview: z.boolean(),
  snippet: z.string().nullable(),
  locations: z.tuple([FileLocationWire], FileLocationWire),
  matchedBy: z.array(z.enum(["words", "meaning"])),
  label: LabelWire.nullable(),
  matchedPage: z.number().int().positive().nullable().optional(),
}) satisfies z.ZodType<FileHit>;

export const FileSearchResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hybrid"), results: z.array(FileHitWire) }),
  z.object({ kind: z.literal("keyword"), reason: KeywordReason, results: z.array(FileHitWire) }),
]);
export type FileSearchResponse = z.infer<typeof FileSearchResponse>;

// Matching protocols and tutorials ride along with the files; they match by keyword either way.
export const SearchResponse = z.intersection(FileSearchResponse, z.object({ protocols: z.array(ProtocolHitWire) }));
export type SearchResponse = z.infer<typeof SearchResponse>;

export const SearchFilters = z.object({
  kind: FileKind.optional(),
  prefix: z.string().trim().min(1).max(500).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  // From the file's label: one outcome, and only files whose label says Check this.
  outcome: LabelOutcome.optional(),
  check: z.stringbool().pipe(z.literal(true)).optional(),
});
export type SearchFilters = z.infer<typeof SearchFilters>;

export const SearchParams = SearchFilters.extend({ q: z.string().trim().min(1).max(300) });
export type SearchParams = z.infer<typeof SearchParams>;

export const EMBED_DIMS = 1024;
export const EmbedResponse = z.object({ embedding: z.array(z.number()).length(EMBED_DIMS) });

export const ProgressRow = z.object({
  source_id: SourceId,
  pending: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export const ProgressRows = z.array(ProgressRow);

export const LabMemberRow = z
  .object({ user_id: UserId, email: z.string().nullable(), role: MemberRole, joined_at: Timestamp })
  .transform((m) => ({ userId: m.user_id, email: m.email, role: m.role, joinedAt: m.joined_at }));
export const LabMemberRows = z.array(LabMemberRow);
export type LabMember = z.infer<typeof LabMemberRow>;

export const CreateLabResult = LabId;
