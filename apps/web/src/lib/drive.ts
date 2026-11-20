import { z } from "zod";
import { FileKind, LabelRow, SourceKind, type FileHit, type Label } from "./domain";
import { FolderFilesRows } from "./folders";
import { countLine, formatSize } from "./format";
import { LocationId, Sha256 } from "./ids";
import { diffCounts, diffLines, type DiffLine, type LineCounts } from "./text-diff";

// The lab drive: every file under its clean name, in folders made from its labels, with the
// versions of each file. decisions.md "the lab drive" says what a version is.

export const DriveBy = z.enum(["experiment", "person", "month"]);
export type DriveBy = z.infer<typeof DriveBy>;

export const DRIVE_ARRANGEMENTS: readonly { by: DriveBy; label: string }[] = [
  { by: "experiment", label: "By experiment" },
  { by: "person", label: "By person" },
  { by: "month", label: "By month" },
];

// A folder's key as drive_folders returns it: an experiment or person id, a month
// ("2026-11"), or "" for the files with no experiment or person yet.
export const DriveKey = z.union([z.literal(""), z.uuid(), z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)]).brand<"DriveKey">();
export type DriveKey = z.infer<typeof DriveKey>;

// "" can't be a path segment, so the address says "none".
const NO_KEY = "none";

export function driveKeyFromSegment(segment: string): DriveKey | null {
  const key = DriveKey.safeParse(segment === NO_KEY ? "" : segment);
  return key.success ? key.data : null;
}

export function driveHref(by: DriveBy): string {
  return by === "experiment" ? "/drive" : `/drive?by=${by}`;
}

export function driveFolderHref(by: DriveBy, key: DriveKey, from = 0): string {
  return `/drive/${by}/${key === "" ? NO_KEY : key}${from > 0 ? `?from=${from}` : ""}`;
}

// The newest version has the plain address, so a link to a file always shows it as it is now.
export function fileHistoryHref(location: LocationId, version: number | null = null): string {
  return `/drive/file/${location}${version === null ? "" : `?v=${version}`}`;
}

export const DRIVE_PAGE_SIZE = 100;

const Count = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().nonnegative());
const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");

export type DriveFolder = { key: DriveKey; name: string | null; files: number; edited: number; changedAt: string };

export const DriveFolderRows = z.array(
  z
    .object({ key: DriveKey, name: z.string().nullable(), files: Count, edited: Count, changed_at: Timestamp })
    .transform((r): DriveFolder => ({ key: r.key, name: r.name, files: r.files, edited: r.edited, changedAt: r.changed_at })),
);

const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

const UNSORTED = { experiment: "No experiment yet", person: "No person yet", month: "No date" } satisfies Record<DriveBy, string>;

export function driveFolderName(by: DriveBy, folder: Pick<DriveFolder, "key" | "name">): string {
  if (folder.key === "") return UNSORTED[by];
  if (by === "month") return monthFormat.format(new Date(`${folder.key}-01T00:00:00Z`));
  return folder.name ?? UNSORTED[by];
}

// Named folders by name, months newest first, and the unsorted folder last either way.
export function sortDriveFolders(by: DriveBy, folders: readonly DriveFolder[]): DriveFolder[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...folders].sort((a, b) => {
    if ((a.key === "") !== (b.key === "")) return a.key === "" ? 1 : -1;
    if (by === "month") return b.key.localeCompare(a.key);
    return collator.compare(driveFolderName(by, a), driveFolderName(by, b));
  });
}

export function driveFolderMeta(folder: Pick<DriveFolder, "files" | "edited">): string {
  const files = countLine(folder.files, "file", "files");
  return folder.edited === 0 ? files : `${files} · ${folder.edited} with older versions`;
}

// A drive row: the file as Browse and Search show it, and how many versions it has. Its
// first location is the place the history is read from.
export type DriveFile = { hit: FileHit; versions: number };

const VersionCounts = z.array(z.object({ versions: Count.pipe(z.number().positive()) }));

export function parseDriveFiles(rows: unknown): DriveFile[] {
  const hits = FolderFilesRows.parse(rows);
  const counts = VersionCounts.parse(rows);
  return hits.map((hit, i) => ({ hit, versions: counts[i]?.versions ?? 1 }));
}

// The name a file goes by: what it's been labeled, or its own name until it has a label.
export function fileTitle(label: Label | null, originalName: string): string {
  return label?.cleanName ?? originalName;
}

export function versionsLine(count: number): string {
  return countLine(count, "version", "versions");
}

export const VersionId = z.uuid().brand<"VersionId">();
export type VersionId = z.infer<typeof VersionId>;

export type FileVersion = {
  id: VersionId;
  number: number;
  sha256: Sha256;
  fileKind: FileKind;
  mime: string;
  size: number;
  // The name and folder the file had when Binary read this content.
  path: string;
  originalName: string;
  // When the source says this content was saved, and when Binary first read it.
  modifiedAt: string;
  seenAt: string;
  hasPreview: boolean;
  label: Label | null;
  sourceKind: SourceKind;
  // The person who uploaded it or the instrument that sent it; Dropbox doesn't say who.
  who: string | null;
};

export const FileHistoryRows = z.array(
  z
    .object({
      id: VersionId,
      number: z.number().int().positive(),
      sha256: Sha256,
      file_kind: FileKind,
      mime: z.string(),
      size: Count,
      path: z.string(),
      original_name: z.string(),
      modified_at: Timestamp,
      seen_at: Timestamp,
      has_preview: z.boolean(),
      label: LabelRow.nullable(),
      source_kind: SourceKind,
      who: z.string().nullable(),
    })
    .transform(
      (r): FileVersion => ({
        id: r.id,
        number: r.number,
        sha256: r.sha256,
        fileKind: r.file_kind,
        mime: r.mime,
        size: r.size,
        path: r.path,
        originalName: r.original_name,
        modifiedAt: r.modified_at,
        seenAt: r.seen_at,
        hasPreview: r.has_preview,
        label: r.label,
        sourceKind: r.source_kind,
        who: r.who,
      }),
    ),
);

// Who a version came from, in the words its source allows.
export function versionSource(version: Pick<FileVersion, "sourceKind" | "who">): string | null {
  if (version.who === null) return null;
  return version.sourceKind === "instrument" ? `sent by ${version.who}` : `uploaded by ${version.who}`;
}

function folderOfPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

// What one version changed from the one before it. `lines` is null when neither version has
// text to compare (a photo) or the change is too long to line up.
export type VersionChange =
  | { kind: "first" }
  | {
      kind: "edit";
      sizeDelta: number;
      renamedFrom: string | null;
      movedFrom: string | null;
      lines: LineCounts | null;
    };

export function versionChange(before: FileVersion | undefined, after: FileVersion, lines: LineCounts | null): VersionChange {
  if (before === undefined) return { kind: "first" };
  return {
    kind: "edit",
    sizeDelta: after.size - before.size,
    renamedFrom: before.originalName === after.originalName ? null : before.originalName,
    movedFrom: folderOfPath(before.path) === folderOfPath(after.path) ? null : folderOfPath(before.path),
    lines,
  };
}

export type VersionDetail = {
  version: FileVersion;
  change: VersionChange;
  // This version's lines against the one before, or its own text for the first; null when
  // there's no text to show or the change is too long to line up.
  lines: DiffLine[] | null;
};

// Pure, so the fixtures build the same details from texts they hold.
export function versionDetails(versions: readonly FileVersion[], texts: readonly (string | null)[]): VersionDetail[] {
  return versions.map((version, i) => {
    const before = versions[i - 1];
    const text = texts[i] ?? null;
    const earlier = texts[i - 1] ?? null;
    const lines = text === null ? null : before === undefined ? diffLines("", text) : earlier === null ? null : diffLines(earlier, text);
    const counts = before === undefined || lines === null ? null : diffCounts(lines);
    return { version, change: versionChange(before, version, counts), lines };
  });
}

function sizeWords(delta: number): string {
  if (delta === 0) return "same size";
  return `${formatSize(Math.abs(delta))} ${delta > 0 ? "larger" : "smaller"}`;
}

// One line for the list of versions: "3 lines added, 1 removed · renamed from old.xlsx".
export function changeLine(change: VersionChange): string {
  if (change.kind === "first") return "The first version Binary read";
  const parts: string[] = [];
  if (change.lines === null) {
    parts.push(`Changed, ${sizeWords(change.sizeDelta)}`);
  } else if (change.lines.added === 0 && change.lines.removed === 0) {
    parts.push(`Same text, ${sizeWords(change.sizeDelta)}`);
  } else {
    const { added, removed } = change.lines;
    if (added > 0 && removed > 0) parts.push(`${countLine(added, "line", "lines")} added, ${removed} removed`);
    else if (added > 0) parts.push(`${countLine(added, "line", "lines")} added`);
    else parts.push(`${countLine(removed, "line", "lines")} removed`);
  }
  if (change.renamedFrom !== null) parts.push(`renamed from ${change.renamedFrom}`);
  if (change.movedFrom !== null) parts.push(`moved from ${change.movedFrom}`);
  return parts.join(" · ");
}

// Files Binary holds can be opened as they were; a Dropbox file's older bytes stay in Dropbox.
export function versionFileHref(version: Pick<FileVersion, "id" | "sourceKind">): string | null {
  switch (version.sourceKind) {
    case "upload":
    case "instrument":
    case "import":
      return `/api/drive/versions/${version.id}`;
    case "dropbox":
    case "local":
      return null;
    default: {
      const _exhaustive: never = version.sourceKind;
      return _exhaustive;
    }
  }
}
