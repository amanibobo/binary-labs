import "server-only";
import { cache } from "react";
import { z } from "zod";
import {
  ExperimentRows,
  FileKind,
  FileLabelRows,
  FileLocation,
  LabMemberRows,
  NeedsLookCount,
  NeedsLookRows,
  PersonRows,
  ProgressRows,
  SourceKind,
  type Experiment,
  type FileHit,
  type LabeledFileHit,
  type LabMember,
  type Person,
} from "./domain";
import { FOLDER_PAGE_SIZE, FolderFilesRows, FolderTreeRows, type FolderPath, type FolderRow } from "./folders";
import { Sha256, SourceId, type LabId, type ProtocolId, type UserId } from "./ids";
import {
  HISTORY_COLUMNS,
  HistoryRows,
  ProtocolListRows,
  ProtocolVersionRows,
  type AuthorNames,
  type HistoryEntry,
  type ProtocolSummary,
  type ProtocolVersion,
} from "./protocols";
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
  disconnected_at: z.string().nullable(),
});

// The lab's newest Dropbox source; one per lab in this slice.
export async function loadSourceState(supabase: Supabase, labId: LabId): Promise<SourceState> {
  const sources = z.array(SourceRow).parse(
    unwrap(
      await supabase
        .from("sources")
        .select("id, root_path, account_label, scan_requested_at, scan_started_at, scan_finished_at, scan_error, disconnected_at")
        .eq("lab_id", labId)
        .eq("kind", "dropbox")
        .order("created_at", { ascending: false })
        .limit(1),
    ),
  );
  const source = sources[0];
  if (source === undefined) return { kind: "not_connected" };
  const progress = ProgressRows.parse(unwrap(await supabase.rpc("source_progress", { p_lab_id: labId })));
  const row = progress.find((p) => p.source_id === source.id);
  const counts = { pending: row?.pending ?? 0, indexed: row?.indexed ?? 0, failed: row?.failed ?? 0 };
  if (source.disconnected_at !== null) {
    return {
      kind: "disconnected",
      sourceId: source.id,
      accountLabel: source.account_label,
      rootPath: source.root_path,
      indexed: counts.indexed,
    };
  }
  if (source.root_path === null) {
    return { kind: "needs_folder", sourceId: source.id, accountLabel: source.account_label };
  }
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

  const [previews, snippets, labels] = await Promise.all([
    supabase.from("previews").select("sha256").eq("lab_id", labId).in("sha256", shas),
    // Chunk 1 is the start of the extracted text (chunk 0 is the name and folder).
    supabase.from("chunks").select("sha256, text").eq("lab_id", labId).eq("ord", 1).in("sha256", shas),
    supabase.rpc("file_labels", { p_lab_id: labId, p_shas: shas }),
  ]);
  const withPreview = new Set(z.array(z.object({ sha256: Sha256 })).parse(unwrap(previews)).map((p) => p.sha256));
  const snippetBySha = new Map(
    z.array(z.object({ sha256: Sha256, text: z.string() })).parse(unwrap(snippets)).map((c) => [c.sha256, c.text]),
  );
  const labelBySha = new Map(FileLabelRows.parse(unwrap(labels)).map((l) => [l.sha256, l.label]));

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
        label: labelBySha.get(sha) ?? null,
      },
    ];
  });
}

const NEEDS_LOOK_LIMIT = 50;

export async function loadNeedsLook(supabase: Supabase, labId: LabId): Promise<LabeledFileHit[]> {
  return NeedsLookRows.parse(unwrap(await supabase.rpc("needs_look_files", { p_lab_id: labId, p_limit: NEEDS_LOOK_LIMIT })));
}

export async function loadNeedsLookCount(supabase: Supabase, labId: LabId): Promise<number> {
  return NeedsLookCount.parse(unwrap(await supabase.rpc("needs_look_count", { p_lab_id: labId })));
}

export async function loadExperiments(supabase: Supabase, labId: LabId): Promise<Experiment[]> {
  return ExperimentRows.parse(
    unwrap(await supabase.from("experiments").select("id, name, aliases").eq("lab_id", labId).order("name")),
  );
}

const RecentUploadExperiments = z.array(z.object({ experiments: z.object({ name: z.string() }).nullable() }));

// The upload page's experiment choices: the ones the lab uploaded to most recently first,
// then the rest by name. Recent ones become one-tap chips.
export function experimentChoices(recent: readonly string[], all: readonly Experiment[]): string[] {
  return [...new Set([...recent, ...all.map((e) => e.name)])];
}

export async function loadUploadChoices(
  supabase: Supabase,
  labId: LabId,
  userId: UserId,
): Promise<{ experiments: string[]; personName: string | null }> {
  const [recent, all, me] = await Promise.all([
    supabase
      .from("uploads")
      .select("experiments(name)")
      .eq("lab_id", labId)
      .not("experiment_id", "is", null)
      .order("uploaded_at", { ascending: false })
      .limit(50),
    loadExperiments(supabase, labId),
    supabase.from("people").select("display_name").eq("lab_id", labId).eq("member_user_id", userId).limit(1),
  ]);
  const recentNames = RecentUploadExperiments.parse(unwrap(recent)).flatMap((r) => (r.experiments === null ? [] : [r.experiments.name]));
  const person = z.array(z.object({ display_name: z.string() })).parse(unwrap(me))[0];
  return { experiments: experimentChoices(recentNames, all), personName: person?.display_name ?? null };
}

export async function loadPeople(supabase: Supabase, labId: LabId): Promise<Person[]> {
  return PersonRows.parse(
    unwrap(await supabase.from("people").select("id, display_name, aliases").eq("lab_id", labId).order("display_name")),
  );
}

// Cached per request: the sidebar's member count and the settings list share one call.
export const loadMembers = cache(async (supabase: Supabase, labId: LabId): Promise<LabMember[]> =>
  LabMemberRows.parse(unwrap(await supabase.rpc("lab_members", { p_lab_id: labId }))),
);

export async function loadFolderTree(supabase: Supabase, labId: LabId): Promise<FolderRow[]> {
  return FolderTreeRows.parse(unwrap(await supabase.rpc("folder_tree", { p_lab_id: labId })));
}

export async function loadFolderFiles(
  supabase: Supabase,
  labId: LabId,
  path: FolderPath,
  offset: number,
): Promise<FileHit[]> {
  return FolderFilesRows.parse(
    unwrap(
      await supabase.rpc("folder_files", { p_lab_id: labId, p_path: path, p_limit: FOLDER_PAGE_SIZE, p_offset: offset }),
    ),
  );
}

export async function loadProtocols(supabase: Supabase, labId: LabId): Promise<ProtocolSummary[]> {
  return ProtocolListRows.parse(unwrap(await supabase.rpc("protocol_list", { p_lab_id: labId })));
}

// Null when the page isn't there, isn't this lab's, or has no such version.
export async function loadProtocolVersion(
  supabase: Supabase,
  id: ProtocolId,
  version: number | null,
): Promise<ProtocolVersion | null> {
  return ProtocolVersionRows.parse(unwrap(await supabase.rpc("protocol_version", { p_protocol_id: id, p_version: version })));
}

export async function loadProtocolHistory(supabase: Supabase, id: ProtocolId): Promise<HistoryEntry[]> {
  return HistoryRows.parse(
    unwrap(
      await supabase.from("protocol_versions").select(HISTORY_COLUMNS).eq("protocol_id", id).order("version", { ascending: false }),
    ),
  );
}

async function loadFileHits(supabase: Supabase, labId: LabId, shas: readonly Sha256[]): Promise<FileHit[]> {
  if (shas.length === 0) return [];
  return FolderFilesRows.parse(unwrap(await supabase.rpc("file_hits", { p_lab_id: labId, p_shas: shas })));
}

// The files a page links, in the order they were linked.
export async function loadLinkedFiles(supabase: Supabase, labId: LabId, id: ProtocolId): Promise<FileHit[]> {
  const links = z
    .array(z.object({ sha256: Sha256 }))
    .parse(unwrap(await supabase.from("protocol_files").select("sha256").eq("protocol_id", id).order("ord")));
  const order = links.map((l) => l.sha256);
  const hits = await loadFileHits(supabase, labId, order);
  return hits.toSorted((a, b) => order.indexOf(a.sha256) - order.indexOf(b.sha256));
}

// A file to start a new page from, with its extracted text (null when it has none).
export async function loadStartFile(
  supabase: Supabase,
  labId: LabId,
  sha: Sha256,
): Promise<{ hit: FileHit; text: string | null } | null> {
  const [hits, text] = await Promise.all([
    loadFileHits(supabase, labId, [sha]),
    supabase.rpc("file_text", { p_lab_id: labId, p_sha256: sha }),
  ]);
  const hit = hits[0];
  if (hit === undefined) return null;
  return { hit, text: z.string().nullable().parse(unwrap(text)) };
}

export async function loadAuthorNames(supabase: Supabase, labId: LabId): Promise<AuthorNames> {
  const members = await loadMembers(supabase, labId);
  return Object.fromEntries(members.flatMap((m) => (m.email === null ? [] : [[m.userId, m.email]])));
}
