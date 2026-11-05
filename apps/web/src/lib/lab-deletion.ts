import { z } from "zod";
import { LabId } from "./ids";
import { KIND_NAMES, ProtocolKind } from "./protocols";

// decisions.md, "deleting a lab and disconnecting Dropbox". The request hides the lab
// at once; the worker removes the rest within minutes and fills in the counts.

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");
const Count = z.number().int().nonnegative();

// The worker's counts (bl_worker/deletion.py): one per lab table, plus blobs and preview files.
const DeletionCounts = z.object({
  file_locations: Count,
  preview_files: Count,
  labels: Count,
  protocols: Count,
  members: Count,
});

export type RemovedCounts = { files: number; previews: number; labels: number; protocols: number; members: number };

export type LabDeletion =
  | { kind: "pending"; labId: LabId; requestedAt: string }
  | { kind: "done"; labId: LabId; requestedAt: string; completedAt: string; removed: RemovedCounts };

export const LAB_DELETION_COLUMNS = "lab_id, requested_at, completed_at, counts";

// A lab_deletions row: counts are filled in when completed_at is.
export const LabDeletionRow = z
  .union([
    z.object({ lab_id: LabId, requested_at: Timestamp, completed_at: z.null() }),
    z.object({ lab_id: LabId, requested_at: Timestamp, completed_at: Timestamp, counts: DeletionCounts }),
  ])
  .transform((r): LabDeletion => {
    if (r.completed_at === null) return { kind: "pending", labId: r.lab_id, requestedAt: r.requested_at };
    const c = r.counts;
    return {
      kind: "done",
      labId: r.lab_id,
      requestedAt: r.requested_at,
      completedAt: r.completed_at,
      removed: { files: c.file_locations, previews: c.preview_files, labels: c.labels, protocols: c.protocols, members: c.members },
    };
  });

export type DeletionFailure = { kind: "wrong_name" } | { kind: "error"; message: string };

// The codes request_lab_deletion raises (db/migrations/0007_deletion.sql).
export function deletionFailure(error: { code?: string }): DeletionFailure {
  switch (error.code) {
    case "BL201":
      return { kind: "wrong_name" };
    case "BL202":
      return { kind: "error", message: "This lab is already being deleted." };
    case "42501":
      return { kind: "error", message: "Only an admin can delete the lab." };
    default:
      return { kind: "error", message: "We couldn't delete the lab. Try again." };
  }
}

// What a person must type: the name exactly, ignoring spaces at either end, as the database checks it.
export function nameMatches({ typed, labName }: { typed: string; labName: string }): boolean {
  return typed.trim() === labName;
}

export type ExportedPage = { kind: ProtocolKind; title: string; version: number; body: string; updatedAt: string };

// protocol_export() rows.
export const ProtocolExportRows = z.array(
  z
    .object({ kind: ProtocolKind, title: z.string(), version: z.number().int().positive(), body: z.string(), updated_at: Timestamp })
    .transform((r): ExportedPage => ({ kind: r.kind, title: r.title, version: r.version, body: r.body, updatedAt: r.updated_at })),
);

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function countLine(pages: readonly ExportedPage[]): string {
  const n = (kind: ProtocolKind) => pages.filter((p) => p.kind === kind).length;
  const protocols = n("protocol");
  const tutorials = n("tutorial");
  const parts = [
    protocols === 0 ? null : `${protocols} ${protocols === 1 ? "protocol" : "protocols"}`,
    tutorials === 0 ? null : `${tutorials} ${tutorials === 1 ? "tutorial" : "tutorials"}`,
  ].filter((p) => p !== null);
  return parts.join(" and ");
}

// One Markdown file with the current version of every live page, for keeping before a lab is deleted.
export function protocolsMarkdown({
  labName,
  exportedAt,
  pages,
}: {
  labName: string;
  exportedAt: Date;
  pages: readonly ExportedPage[];
}): string {
  const date = day.format(exportedAt);
  const intro =
    pages.length === 0
      ? `Exported from Binary on ${date}. The lab has no protocols or tutorials yet.`
      : `Exported from Binary on ${date}: ${countLine(pages)}, the current version of each.`;
  const sections = pages.map(
    (p) => `# ${p.title}\n\n${KIND_NAMES[p.kind]}, version ${p.version}, saved ${day.format(new Date(p.updatedAt))}\n\n${p.body.trim()}\n`,
  );
  return [`# ${labName} protocols\n\n${intro}\n`, ...sections].join("\n---\n\n");
}

export function exportFileName(labName: string): string {
  const slug = labName
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "protocols.md" : `${slug}-protocols.md`;
}
