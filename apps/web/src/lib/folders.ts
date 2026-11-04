import { z } from "zod";
import { FileHitWire, FileKind, FileLocation, type FileHit } from "./domain";
import { Sha256 } from "./ids";

// A folder relative to the source root: "" is the root, then "P450", "P450/batch3".
export const FolderPath = z
  .string()
  .regex(/^(?:[^/]+(?:\/[^/]+)*)?$/, "expected a relative folder path")
  .brand<"FolderPath">();
export type FolderPath = z.infer<typeof FolderPath>;

export const ROOT_FOLDER: FolderPath = FolderPath.parse("");

export const FOLDER_PAGE_SIZE = 100;

function segmentsOf(path: FolderPath): string[] {
  return path === "" ? [] : path.split("/");
}

function parentOf(path: FolderPath): FolderPath | null {
  const segments = segmentsOf(path);
  return segments.length === 0 ? null : FolderPath.parse(segments.slice(0, -1).join("/"));
}

export function folderName(path: FolderPath): string {
  return segmentsOf(path).at(-1) ?? "";
}

export function folderAncestors(path: FolderPath): FolderPath[] {
  const segments = segmentsOf(path);
  return Array.from({ length: segments.length + 1 }, (_, i) => FolderPath.parse(segments.slice(0, i).join("/")));
}

export function topLevelOf(path: FolderPath): FolderPath | null {
  const first = segmentsOf(path)[0];
  return first === undefined ? null : FolderPath.parse(first);
}

export function folderPathFromSegments(segments: readonly string[] | undefined): FolderPath | null {
  if (segments === undefined) return ROOT_FOLDER;
  if (segments.some((s) => s === "" || s.includes("/"))) return null;
  return FolderPath.parse(segments.join("/"));
}

export function folderHref(path: FolderPath): string {
  const segments = segmentsOf(path);
  return segments.length === 0 ? "/browse" : `/browse/${segments.map(encodeURIComponent).join("/")}`;
}

export type FolderRow = { path: FolderPath; parent: FolderPath | null; directFiles: number; totalFiles: number };

// PostgREST sends bigint as a JSON number, but a numeric string is also a valid encoding.
const Count = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative());

const FolderTreeRow = z
  .object({ path: FolderPath, parent: FolderPath.nullable(), direct_files: Count, total_files: Count })
  .refine((r) => r.parent === parentOf(r.path), "parent does not match path")
  .transform(
    (r): FolderRow => ({ path: r.path, parent: r.parent, directFiles: r.direct_files, totalFiles: r.total_files }),
  );
export const FolderTreeRows = z.array(FolderTreeRow);

export type FolderNode = {
  path: FolderPath;
  name: string;
  depth: number;
  directFiles: number;
  totalFiles: number;
  children: FolderNode[];
};
export type FolderTree = { root: FolderNode; byPath: ReadonlyMap<FolderPath, FolderNode> };

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function buildFolderTree(rows: readonly FolderRow[]): FolderTree {
  const rowByPath = new Map(rows.map((r) => [r.path, r]));
  const byPath = new Map<FolderPath, FolderNode>();
  const nodeFor = (path: FolderPath): FolderNode => {
    const existing = byPath.get(path);
    if (existing !== undefined) return existing;
    const row = rowByPath.get(path);
    const node: FolderNode = {
      path,
      name: folderName(path),
      depth: segmentsOf(path).length,
      directFiles: row?.directFiles ?? 0,
      totalFiles: row?.totalFiles ?? 0,
      children: [],
    };
    byPath.set(path, node);
    const parent = parentOf(path);
    if (parent !== null) nodeFor(parent).children.push(node);
    return node;
  };
  const root = nodeFor(ROOT_FOLDER);
  for (const row of rows) nodeFor(row.path);
  for (const node of byPath.values()) node.children.sort((a, b) => byName.compare(a.name, b.name));
  return { root, byPath };
}

const FolderFilesRow = z
  .object({
    sha256: Sha256,
    file_kind: FileKind,
    mime: z.string(),
    size: Count,
    has_preview: z.boolean(),
    snippet: z.string().nullable(),
    locations: z.tuple([FileLocation], FileLocation),
  })
  .transform(
    (r): FileHit => ({
      sha256: r.sha256,
      fileKind: r.file_kind,
      mime: r.mime,
      size: r.size,
      hasPreview: r.has_preview,
      snippet: r.snippet,
      locations: r.locations,
      matchedBy: [],
    }),
  );
export const FolderFilesRows = z.array(FolderFilesRow);

export type BrowseResponse = { files: FileHit[] };
export const BrowseResponse = z.object({ files: z.array(FileHitWire) }) satisfies z.ZodType<BrowseResponse>;
