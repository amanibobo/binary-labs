import { z } from "zod";
import { LabId, Sha256, SourceId, UserId } from "./ids";

// Mirrors of the enums in db/migrations/0001_core.sql.
export const FILE_KINDS = ["pdf", "spreadsheet", "document", "text", "image", "other"] as const;
export const FileKind = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKind>;

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
  }));
export const SearchFilesRows = z.array(SearchFilesRow);

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
}) satisfies z.ZodType<FileHit>;

export const SearchResponse = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hybrid"), results: z.array(FileHitWire) }),
  z.object({ kind: z.literal("keyword"), reason: KeywordReason, results: z.array(FileHitWire) }),
]);
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
