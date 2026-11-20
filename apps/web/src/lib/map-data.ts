import "server-only";
import type { LabId } from "./ids";
import {
  HUB_FILE_LIMIT,
  HubFiles,
  HubView,
  LocalView,
  savedViewOf,
  type Depth,
  type HubQuery,
  type HubsQuery,
  type LocalQuery,
  type MapViewSave,
  type SavedMapView,
} from "./map";
import { unwrap, type Supabase } from "./supabase/server";

// The lab map's three views, one SQL function each (db/migrations/0021_lab_map.sql, with tags
// and similar hubs in 0032), and each member's saved view of it. They run as the member, so
// RLS decides what any of them can see.

export async function loadHubView(supabase: Supabase, labId: LabId, q: HubsQuery): Promise<HubView> {
  return HubView.parse(unwrap(await supabase.rpc("lab_map", { p_lab_id: labId, p_similar: q.similar, p_tags: q.tags })));
}

// Null when the lab has no such hub.
export async function loadHubFiles(supabase: Supabase, labId: LabId, q: HubQuery): Promise<HubFiles | null> {
  const data = unwrap(
    await supabase.rpc("lab_map_hub", {
      p_lab_id: labId,
      p_hub: q.id,
      p_limit: HUB_FILE_LIMIT,
      p_similar: q.similar,
      p_with: q.with,
      p_tags: q.tags,
    }),
  );
  return data === null ? null : HubFiles.parse(data);
}

export async function loadLocalView(supabase: Supabase, labId: LabId, q: LocalQuery): Promise<LocalView | null> {
  const data = unwrap(
    await supabase.rpc("lab_map_local", {
      p_lab_id: labId,
      p_node: q.around,
      p_depth: q.depth satisfies Depth,
      p_similar: q.similar,
      p_tags: q.tags,
    }),
  );
  return data === null ? null : LocalView.parse(data);
}

// The member's own view of this lab's map; RLS hands back only their row.
export async function loadSavedView(supabase: Supabase, labId: LabId): Promise<SavedMapView> {
  const row = unwrap(
    await supabase.from("map_views").select("camera, open_hubs, hidden_kinds, show_similar, show_tags").eq("lab_id", labId).maybeSingle(),
  );
  return savedViewOf(row);
}

export async function saveView(supabase: Supabase, labId: LabId, save: MapViewSave): Promise<void> {
  unwrap(
    await supabase.rpc("save_map_view", {
      p_lab_id: labId,
      p_camera: save.place?.camera ?? null,
      p_open: save.place?.open ?? null,
      p_hidden: save.hidden,
      p_similar: save.similar,
      p_tags: save.tags,
    }),
  );
}
