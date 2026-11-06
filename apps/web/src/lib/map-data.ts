import "server-only";
import type { LabId } from "./ids";
import { HUB_FILE_LIMIT, HubFiles, HubView, LocalView, type Depth, type HubQuery, type LocalQuery } from "./map";
import { unwrap, type Supabase } from "./supabase/server";

// The lab map's three views, one SQL function each (db/migrations/0016_lab_map.sql). They run
// as the member, so RLS decides what any of them can see.

export async function loadHubView(supabase: Supabase, labId: LabId): Promise<HubView> {
  return HubView.parse(unwrap(await supabase.rpc("lab_map", { p_lab_id: labId })));
}

// Null when the lab has no such hub.
export async function loadHubFiles(supabase: Supabase, labId: LabId, q: HubQuery): Promise<HubFiles | null> {
  const data = unwrap(
    await supabase.rpc("lab_map_hub", { p_lab_id: labId, p_hub: q.id, p_limit: HUB_FILE_LIMIT, p_similar: q.similar, p_with: q.with }),
  );
  return data === null ? null : HubFiles.parse(data);
}

export async function loadLocalView(supabase: Supabase, labId: LabId, q: LocalQuery): Promise<LocalView | null> {
  const data = unwrap(
    await supabase.rpc("lab_map_local", { p_lab_id: labId, p_node: q.around, p_depth: q.depth satisfies Depth, p_similar: q.similar }),
  );
  return data === null ? null : LocalView.parse(data);
}
