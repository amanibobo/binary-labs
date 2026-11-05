import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkSpec, CHART_COLUMNS, ChartRows, type ChartSpec, type SavedChart } from "./charts";
import { DataTables, TableState } from "./data-tables";
import { LocationId, Sha256, type ChartId, type LabId, type ProtocolId } from "./ids";
import { FileKind } from "./domain";
import { logError } from "./log";
import { readObject } from "./object-store";
import { unwrap, type Supabase } from "./supabase/server";

// The routes' core for tables and charts. Every read goes through the member's session, so RLS
// decides what a lab sees, and every object key is checked to sit under the viewer's lab.

const TableRow = z.object({
  state: z.enum(["waiting", "ready", "failed"]),
  storage_key: z.string().nullable(),
  error: z.string().nullable(),
});

export function tablePrefix(labId: LabId): string {
  return `${labId}/tables/`;
}

export async function readTables(labId: LabId, key: string): Promise<DataTables> {
  if (!key.startsWith(tablePrefix(labId))) throw new Error(`table key outside the lab: ${key}`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of await readObject(key)) chunks.push(chunk);
  return DataTables.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export async function tableState(supabase: Supabase, labId: LabId, sha: Sha256): Promise<TableState> {
  const rows = z
    .array(TableRow)
    .parse(unwrap(await supabase.from("data_tables").select("state, storage_key, error").eq("lab_id", labId).eq("sha256", sha).limit(1)));
  const row = rows[0];
  if (row === undefined) return { state: "missing" };
  switch (row.state) {
    case "waiting":
      return { state: "waiting" };
    case "failed":
      return { state: "failed", error: row.error ?? "We couldn't read a table in this file." };
    case "ready":
      if (row.storage_key === null) throw new Error("a ready table without a key");
      return { state: "ready", tables: await readTables(labId, row.storage_key) };
    default: {
      const _exhaustive: never = row.state;
      return _exhaustive;
    }
  }
}

// Why a chart can't be saved against the file's table, or null when it can.
export async function chartProblem(
  supabase: Supabase,
  labId: LabId,
  chart: { sha256: Sha256; sheet: string; spec: ChartSpec },
): Promise<string | null> {
  const state = await tableState(supabase, labId, chart.sha256);
  if (state.state !== "ready") return "This file's table isn't ready yet.";
  const table = state.tables.tables.find((t) => t.name === chart.sheet);
  if (table === undefined) return `There's no table called ${chart.sheet} in this file.`;
  return checkSpec(chart.spec, table);
}

export async function loadCharts(
  supabase: Supabase,
  labId: LabId,
  where: { kind: "file"; sha256: Sha256 } | { kind: "protocol"; protocolId: ProtocolId },
): Promise<SavedChart[]> {
  const query = supabase.from("charts").select(CHART_COLUMNS).eq("lab_id", labId);
  const filtered = where.kind === "file" ? query.eq("sha256", where.sha256) : query.eq("protocol_id", where.protocolId);
  return ChartRows.parse(unwrap(await filtered.order("created_at", { ascending: true })));
}

const FileRow = z.object({ id: LocationId, sha256: Sha256, original_name: z.string() });

export type ChartFileRef = { locationId: LocationId; sha256: Sha256; name: string };

// The file a new chart starts from, when it's a data sheet in the viewer's lab.
export async function loadChartFile(
  supabase: Supabase,
  labId: LabId,
  locationId: LocationId,
): Promise<{ kind: "ok"; file: ChartFileRef } | { kind: "missing" } | { kind: "not_a_sheet"; name: string }> {
  const [row] = z.array(FileRow).parse(
    unwrap(
      await supabase
        .from("file_locations")
        .select("id, sha256, original_name")
        .eq("lab_id", labId)
        .eq("id", locationId)
        .is("deleted_at", null)
        .not("sha256", "is", null)
        .limit(1),
    ),
  );
  if (row === undefined) return { kind: "missing" };
  const [blob] = z
    .array(z.object({ file_kind: FileKind }))
    .parse(unwrap(await supabase.from("blobs").select("file_kind").eq("sha256", row.sha256).limit(1)));
  if (blob?.file_kind !== "spreadsheet") return { kind: "not_a_sheet", name: row.original_name };
  return { kind: "ok", file: { locationId: row.id, sha256: row.sha256, name: row.original_name } };
}

// A live place each file lives, to name it and link to it; a file removed since has none.
export async function loadFileRefs(supabase: Supabase, labId: LabId, shas: readonly Sha256[]): Promise<Map<Sha256, ChartFileRef>> {
  if (shas.length === 0) return new Map();
  const rows = z.array(FileRow).parse(
    unwrap(
      await supabase
        .from("file_locations")
        .select("id, sha256, original_name")
        .eq("lab_id", labId)
        .in("sha256", [...new Set(shas)])
        .is("deleted_at", null)
        .order("modified_at", { ascending: false }),
    ),
  );
  const refs = new Map<Sha256, ChartFileRef>();
  for (const r of rows) if (!refs.has(r.sha256)) refs.set(r.sha256, { locationId: r.id, sha256: r.sha256, name: r.original_name });
  return refs;
}

export async function loadChart(supabase: Supabase, labId: LabId, id: ChartId): Promise<SavedChart | null> {
  const [chart] = ChartRows.parse(unwrap(await supabase.from("charts").select(CHART_COLUMNS).eq("lab_id", labId).eq("id", id).limit(1)));
  return chart ?? null;
}

export async function loadProtocolCharts(
  supabase: Supabase,
  labId: LabId,
  protocolId: ProtocolId,
): Promise<{ chart: SavedChart; file: { name: string; locationId: LocationId } | null }[]> {
  const charts = await loadCharts(supabase, labId, { kind: "protocol", protocolId });
  const refs = await loadFileRefs(supabase, labId, charts.map((c) => c.sha256));
  return charts.map((chart) => {
    const ref = refs.get(chart.sha256);
    return { chart, file: ref === undefined ? null : { name: ref.name, locationId: ref.locationId } };
  });
}

const NO_STORE = { "cache-control": "private, no-store" };

// A database refusal as the browser should see it.
export function chartError(error: { code?: string; message: string }, ctx: { event: string; labId: LabId }): NextResponse {
  const known: Record<string, [number, string]> = {
    "42501": [403, "You're not a member of this lab."],
    BL104: [404, "That file isn't in this lab any more."],
    BL103: [404, "That protocol isn't in this lab."],
    BL102: [409, "That protocol is archived. Pick another, or none."],
    "23514": [400, "Check the chart's settings and try again."],
  };
  const hit = error.code === undefined ? undefined : known[error.code];
  if (hit === undefined) {
    logError(ctx.event, { labId: ctx.labId, error });
    return NextResponse.json({ error: "We couldn't save that chart. Try again." }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ error: hit[1] }, { status: hit[0], headers: NO_STORE });
}
