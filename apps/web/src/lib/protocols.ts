import { z } from "zod";
import { ProtocolId, ProtocolVersionId, Sha256, UserId, type LabId } from "./ids";

// Mirrors protocol_kind in db/migrations/0006_protocols.sql.
export const PROTOCOL_KINDS = ["protocol", "tutorial"] as const;
export const ProtocolKind = z.enum(PROTOCOL_KINDS);
export type ProtocolKind = z.infer<typeof ProtocolKind>;

export const KIND_NAMES = { protocol: "Protocol", tutorial: "Tutorial" } satisfies Record<ProtocolKind, string>;

// The column checks in 0006_protocols.sql.
export const TITLE_MAX = 200;
export const BODY_MAX = 200_000;
export const NOTE_MAX = 300;

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");
const VersionNumber = z.number().int().positive();

export type ProtocolSummary = {
  id: ProtocolId;
  kind: ProtocolKind;
  title: string;
  version: number;
  author: UserId | null;
  updatedAt: string;
};

// protocol_list() rows.
export const ProtocolListRows = z.array(
  z
    .object({
      id: ProtocolId,
      kind: ProtocolKind,
      title: z.string(),
      version: VersionNumber,
      author: UserId.nullable(),
      updated_at: Timestamp,
    })
    .transform(
      (r): ProtocolSummary => ({ id: r.id, kind: r.kind, title: r.title, version: r.version, author: r.author, updatedAt: r.updated_at }),
    ),
);

// One saved version of a page, with where it stands: the current version may have moved on.
export type ProtocolVersion = {
  protocolId: ProtocolId;
  kind: ProtocolKind;
  archived: boolean;
  currentVersionId: ProtocolVersionId;
  currentVersion: number;
  id: ProtocolVersionId;
  version: number;
  title: string;
  body: string;
  note: string | null;
  author: UserId | null;
  createdAt: string;
};

export const ProtocolVersionWire = z.object({
  protocolId: ProtocolId,
  kind: ProtocolKind,
  archived: z.boolean(),
  currentVersionId: ProtocolVersionId,
  currentVersion: VersionNumber,
  id: ProtocolVersionId,
  version: VersionNumber,
  title: z.string(),
  body: z.string(),
  note: z.string().nullable(),
  author: UserId.nullable(),
  createdAt: Timestamp,
}) satisfies z.ZodType<ProtocolVersion>;

// protocol_version() answers no row for a page that isn't there (or isn't this lab's).
export const ProtocolVersionRows = z
  .array(
    z
      .object({
        protocol_id: ProtocolId,
        kind: ProtocolKind,
        archived_at: Timestamp.nullable(),
        current_version_id: ProtocolVersionId,
        current_version: VersionNumber,
        version_id: ProtocolVersionId,
        version: VersionNumber,
        title: z.string(),
        body: z.string(),
        note: z.string().nullable(),
        author: UserId.nullable(),
        created_at: Timestamp,
      })
      .transform(
        (r): ProtocolVersion => ({
          protocolId: r.protocol_id,
          kind: r.kind,
          archived: r.archived_at !== null,
          currentVersionId: r.current_version_id,
          currentVersion: r.current_version,
          id: r.version_id,
          version: r.version,
          title: r.title,
          body: r.body,
          note: r.note,
          author: r.author,
          createdAt: r.created_at,
        }),
      ),
  )
  .max(1)
  .transform((rows) => rows[0] ?? null);

export function isCurrent(v: ProtocolVersion): boolean {
  return v.id === v.currentVersionId;
}

export type HistoryEntry = { id: ProtocolVersionId; version: number; title: string; note: string | null; author: UserId | null; createdAt: string };

export const HISTORY_COLUMNS = "id, version, title, note, author, created_at";

export const HistoryRows = z.array(
  z
    .object({
      id: ProtocolVersionId,
      version: VersionNumber,
      title: z.string(),
      note: z.string().nullable(),
      author: UserId.nullable(),
      created_at: Timestamp,
    })
    .transform((r): HistoryEntry => ({ id: r.id, version: r.version, title: r.title, note: r.note, author: r.author, createdAt: r.created_at })),
);

// A search hit: the current version's title and a plain-text excerpt of its body.
export type ProtocolHit = { id: ProtocolId; kind: ProtocolKind; title: string; version: number; snippet: string };

export const ProtocolHitWire = z.object({
  id: ProtocolId,
  kind: ProtocolKind,
  title: z.string(),
  version: VersionNumber,
  snippet: z.string(),
}) satisfies z.ZodType<ProtocolHit>;

export const SearchProtocolsRows = z.array(
  ProtocolHitWire.extend({ snippet: z.string().nullable() }).transform(
    (r): ProtocolHit => ({ ...r, snippet: plainText(r.snippet ?? "") }),
  ),
);

export const PROTOCOL_HITS_SHOWN = 5;

// Markdown syntax reads as noise in a one-line excerpt; keep only the words.
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+(.*?)\s*$/gm, "$1:")
    .replace(/^\s{0,3}(?:>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "")
    .replace(/[*_~`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const Title = z.string().trim().min(1, "Give the page a title.").max(TITLE_MAX, `Keep the title under ${TITLE_MAX} characters.`);
const Body = z.string().max(BODY_MAX, "This page is too long to save.");
const Note = z
  .string()
  .trim()
  .max(NOTE_MAX, `Keep the note under ${NOTE_MAX} characters.`)
  .transform((s) => (s === "" ? null : s))
  .nullable();

export const CreateProtocolRequest = z.object({
  kind: ProtocolKind,
  title: Title,
  body: Body,
  note: Note,
  // The indexed file this page starts from; it gets linked to the page.
  fromSha256: Sha256.nullable(),
});
export type CreateProtocolRequest = z.input<typeof CreateProtocolRequest>;

export const SaveProtocolRequest = z.object({ baseVersionId: ProtocolVersionId, title: Title, body: Body, note: Note });
export type SaveProtocolRequest = z.input<typeof SaveProtocolRequest>;

export const FileLinkRequest = z.object({ sha256: Sha256 });

export function createProtocolArgs(labId: LabId, req: z.output<typeof CreateProtocolRequest>) {
  return {
    p_lab_id: labId,
    p_kind: req.kind,
    p_title: req.title,
    p_body: req.body,
    p_note: req.note,
    p_file_sha256: req.fromSha256,
  };
}

export function saveProtocolArgs(id: ProtocolId, req: z.output<typeof SaveProtocolRequest>) {
  return { p_protocol_id: id, p_base_version_id: req.baseVersionId, p_title: req.title, p_body: req.body, p_note: req.note };
}

export type SavedVersion = { protocolId: ProtocolId; versionId: ProtocolVersionId; version: number };

export const SavedVersionWire = z.object({
  protocolId: ProtocolId,
  versionId: ProtocolVersionId,
  version: VersionNumber,
}) satisfies z.ZodType<SavedVersion>;

// create_protocol and save_protocol both answer one row naming the version they wrote.
export const SavedVersionRows = z
  .tuple([z.object({ protocol_id: ProtocolId, version_id: ProtocolVersionId, version: VersionNumber })])
  .transform(([r]): SavedVersion => ({ protocolId: r.protocol_id, versionId: r.version_id, version: r.version }));

// A save either lands or finds someone else saved first; anything else is an error.
export type SaveOutcome = ({ kind: "saved" } & SavedVersion) | { kind: "stale" };

export const SaveOutcomeWire = z.discriminatedUnion("kind", [
  SavedVersionWire.extend({ kind: z.literal("saved") }),
  z.object({ kind: z.literal("stale") }),
]) satisfies z.ZodType<SaveOutcome>;

export type ProtocolFailure = { kind: "stale" } | { kind: "error"; status: number; message: string };

// The codes 0006_protocols.sql raises; everything else is our fault, not the person's.
export function protocolFailure(error: { code?: string; message: string }): ProtocolFailure {
  switch (error.code) {
    case "BL101":
      return { kind: "stale" };
    case "BL102":
      return { kind: "error", status: 409, message: "This page is archived, so it can't change." };
    case "BL103":
      return { kind: "error", status: 404, message: "This page isn't in your lab." };
    case "BL104":
      return { kind: "error", status: 400, message: "That file isn't in your lab's index." };
    case "23514":
      return { kind: "error", status: 400, message: `A page needs a title under ${TITLE_MAX} characters.` };
    case "42501":
      return { kind: "error", status: 403, message: "You're not a member of this lab." };
    default:
      return { kind: "error", status: 500, message: "We couldn't save that. Try again." };
  }
}

// What a page started from a file looks like before anyone edits it.
export function titleFromFile({ cleanName, originalName }: { cleanName: string | null; originalName: string }): string {
  if (cleanName !== null) return cleanName.slice(0, TITLE_MAX);
  const dot = originalName.lastIndexOf(".");
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  return stem.replace(/[_]+/g, " ").trim().slice(0, TITLE_MAX) || originalName.slice(0, TITLE_MAX);
}

export function protocolHref(id: ProtocolId, version?: number): string {
  return version === undefined ? `/protocols/${id}` : `/protocols/${id}?version=${version}`;
}

export function newProtocolHref(fromSha256?: Sha256): string {
  return fromSha256 === undefined ? "/protocols/new" : `/protocols/new?from=${fromSha256}`;
}

// Authors by user id; someone who has left the lab no longer has an email here.
export type AuthorNames = Readonly<Record<string, string>>;

export function authorName(names: AuthorNames, id: UserId | null): string {
  return (id === null ? undefined : names[id]) ?? "a former member";
}
