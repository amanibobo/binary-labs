import "server-only";
import { z } from "zod";
import { FileKind, FileLocation, LabMemberRows, ProgressRows, SourceKind, type FileHit, type LabMember } from "./domain";
import { Sha256, SourceId, type LabId } from "./ids";
import { deriveScan, type SourceState } from "./source-state";
import { unwrap, type Supabase } from "./supabase/server";

const SourceRow = z.object({
  id: SourceId,
  root_path: z.string().nullable(),
  account_label: z.string().nullable(),
  scan_requested_at: z.string().nullable(),
  scan_started_at: z.string().nullable(),
  scan_finished_at: z.string().nullable(),
  scan_error: z.string().nullable(),
});

// The lab's newest Dropbox source; one per lab in this slice.
export async function loadSourceState(supabase: Supabase, labId: LabId): Promise<SourceState> {
  const sources = z.array(SourceRow).parse(
    unwrap(
      await supabase
        .from("sources")
        .select("id, root_path, account_label, scan_requested_at, scan_started_at, scan_finished_at, scan_error")
        .eq("lab_id", labId)
        .eq("kind", "dropbox")
        .order("created_at", { ascending: false })
        .limit(1),
    ),
  );
  const source = sources[0];
  if (source === undefined) return { kind: "not_connected" };
  if (source.root_path === null) {
    return { kind: "needs_folder", sourceId: source.id, accountLabel: source.account_label };
  }
  const progress = ProgressRows.parse(unwrap(await supabase.rpc("source_progress", { p_lab_id: labId })));
  const row = progress.find((p) => p.source_id === source.id);
  const counts = { pending: row?.pending ?? 0, indexed: row?.indexed ?? 0, failed: row?.failed ?? 0 };
  return {
    kind: "connected",
    sourceId: source.id,
    accountLabel: source.account_label,
    rootPath: source.root_path,
    scan: deriveScan(
      {
        requestedAt: source.scan_requested_at,
        startedAt: source.scan_started_at,
        finishedAt: source.scan_finished_at,
        error: source.scan_error,
      },
      counts,
    ),
  };
}

const RecentRow = z.object({
  id: z.uuid(),
  sha256: Sha256,
  source_id: SourceId,
  path: z.string(),
  original_name: z.string(),
  modified_at: z.string(),
  size: z.number(),
  blobs: z.object({ file_kind: FileKind, mime: z.string() }),
  sources: z.object({ kind: SourceKind }),
});

type RecentRow = z.infer<typeof RecentRow>;

const RECENT_LIMIT = 12;

export async function loadRecentFiles(supabase: Supabase, labId: LabId): Promise<FileHit[]> {
  const rows = z.array(RecentRow).parse(
    unwrap(
      await supabase
        .from("file_locations")
        .select("id, sha256, source_id, path, original_name, modified_at, size, blobs!inner(file_kind, mime), sources!inner(kind)")
        .eq("lab_id", labId)
        .eq("index_state", "indexed")
        .is("deleted_at", null)
        .order("modified_at", { ascending: false })
        .limit(RECENT_LIMIT * 3),
    ),
  );
  const bySha = new Map<Sha256, RecentRow[]>();
  for (const row of rows) bySha.set(row.sha256, [...(bySha.get(row.sha256) ?? []), row]);
  const shas = [...bySha.keys()].slice(0, RECENT_LIMIT);
  if (shas.length === 0) return [];

  const [previews, snippets] = await Promise.all([
    supabase.from("previews").select("sha256").eq("lab_id", labId).in("sha256", shas),
    // Chunk 1 is the start of the extracted text (chunk 0 is the name and folder).
    supabase.from("chunks").select("sha256, text").eq("lab_id", labId).eq("ord", 1).in("sha256", shas),
  ]);
  const withPreview = new Set(z.array(z.object({ sha256: Sha256 })).parse(unwrap(previews)).map((p) => p.sha256));
  const snippetBySha = new Map(
    z.array(z.object({ sha256: Sha256, text: z.string() })).parse(unwrap(snippets)).map((c) => [c.sha256, c.text]),
  );

  const toLocation = (r: RecentRow) => FileLocation.parse({ ...r, source_kind: r.sources.kind });
  return shas.flatMap((sha): FileHit[] => {
    const [head, ...rest] = bySha.get(sha) ?? [];
    if (head === undefined) return [];
    return [
      {
        sha256: sha,
        fileKind: head.blobs.file_kind,
        mime: head.blobs.mime,
        size: head.size,
        hasPreview: withPreview.has(sha),
        snippet: snippetBySha.get(sha) ?? null,
        locations: [toLocation(head), ...rest.map(toLocation)],
        matchedBy: [],
      },
    ];
  });
}

export async function loadMembers(supabase: Supabase, labId: LabId): Promise<LabMember[]> {
  return LabMemberRows.parse(unwrap(await supabase.rpc("lab_members", { p_lab_id: labId })));
}
