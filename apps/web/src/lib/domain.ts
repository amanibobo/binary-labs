import { z } from "zod";
import { CorrectionId, ExperimentId, LabId, PersonId, Sha256, SourceId, UserId } from "./ids";
import { ProtocolHitWire } from "./protocols";

// Mirrors of the enums in db/migrations/0001_core.sql.
export const FILE_KINDS = ["pdf", "spreadsheet", "document", "text", "image", "other"] as const;
export const FileKind = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKind>;

// The kinds the worker extracts text from, so a page can start from one.
export function isTextBearing(kind: FileKind): boolean {
  return kind === "pdf" || kind === "document" || kind === "text" || kind === "spreadsheet";
}

export const MemberRole = z.enum(["admin", "member"]);
export type MemberRole = z.infer<typeof MemberRole>;

export const SourceKind = z.enum(["dropbox", "local"]);

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
  "protocol.export",
  "source.disconnect",
  "lab.delete",
]);
export type AuditAction = z.infer<typeof AuditAction>;

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");

export const FileLocation = z
  .object({
    id: z.uuid(),
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

// Mirrors label_status in db/migrations/0004_labels.sql.
export const LabelStatus = z.enum(["suggested", "check", "needs_look", "accepted", "corrected"]);
export type LabelStatus = z.infer<typeof LabelStatus>;

export const IsoDate = z.iso.date();

export type ExperimentRef = { id: ExperimentId; name: string };
export type PersonRef = { id: PersonId; name: string };

// Everything on a label besides its name: the tags a correction replaces.
export type LabelDetails = {
  date: string | null;
  experiment: ExperimentRef | null;
  person: PersonRef | null;
  instrument: string | null;
  tags: string[];
};

// "Needs a look" is the one state with no name to show.
export type Label = LabelDetails & { confidence: number } & (
    | { status: "needs_look"; cleanName: null }
    | { status: Exclude<LabelStatus, "needs_look">; cleanName: string }
  );

export function needsCheck(label: Label | null): boolean {
  return label?.status === "check";
}

const ExperimentRefSchema = z.object({ id: ExperimentId, name: z.string() });
const PersonRefSchema = z.object({ id: PersonId, name: z.string() });

const labelFields = {
  status: LabelStatus,
  date: IsoDate.nullable(),
  experiment: ExperimentRefSchema.nullable(),
  person: PersonRefSchema.nullable(),
  instrument: z.string().nullable(),
  tags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
};

type FlatLabel = LabelDetails & { status: LabelStatus; cleanName: string | null; confidence: number };

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
  .object({ ...labelFields, clean_name: z.string().nullable() })
  .transform(({ clean_name, ...r }, ctx) => toLabel({ ...r, cleanName: clean_name }, ctx));

export const LabelWire = z
  .object({ ...labelFields, cleanName: z.string().nullable() })
  .transform((r, ctx) => toLabel(r, ctx)) satisfies z.ZodType<Label>;

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

const FileLocationWire = z.object({
  id: z.string(),
  sourceId: SourceId,
  sourceKind: SourceKind,
  path: z.string(),
  originalName: z.string(),
  modifiedAt: Timestamp,
}) satisfies z.ZodType<FileLocation>;

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
