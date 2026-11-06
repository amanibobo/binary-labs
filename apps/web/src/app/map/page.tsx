import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { MapView } from "@/components/map/map-view";
import { depthOf, LocalQuery, nodeName } from "@/lib/map";
import { loadHubView, loadLocalView } from "@/lib/map-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Map" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// /map is the lab at a glance; /map?around=<node>[&depth=2] is the map around one thing.
export default async function MapPage({ searchParams }: PageProps<"/map">) {
  const params = await searchParams;
  const around = one(params.around);
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  if (around === undefined) {
    const [shell, view] = await Promise.all([loadShell(viewer), loadHubView(supabase, lab.id)]);
    return (
      <AppShell shell={shell} location={{ section: "map" }}>
        <MapView mode={{ kind: "global", view }} />
      </AppShell>
    );
  }
  const q = LocalQuery.safeParse({ around, depth: depthOf(one(params.depth)), similar: false });
  if (!q.success) notFound();
  const [shell, view] = await Promise.all([loadShell(viewer), loadLocalView(supabase, lab.id, q.data)]);
  const center = view?.nodes.find((n) => n.id === view.center);
  if (view === null || center === undefined) notFound();
  return (
    <AppShell shell={shell} location={{ section: "map" }}>
      <MapView mode={{ kind: "local", view, centerName: nodeName(center) }} />
    </AppShell>
  );
}
