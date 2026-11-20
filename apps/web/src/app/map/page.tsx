import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { MapView } from "@/components/map/map-view";
import { depthOf, LocalQuery, nodeName } from "@/lib/map";
import { loadHubView, loadLocalView, loadSavedView } from "@/lib/map-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Map" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// /map is the lab at a glance; /map?around=<node>[&depth=2] is the map around one thing. Both
// open as this member left them: their switches and filters, and on the lab map their camera
// and open hubs.
export default async function MapPage({ searchParams }: PageProps<"/map">) {
  const params = await searchParams;
  const around = one(params.around);
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  if (around === undefined) {
    const [shell, { saved, view }] = await Promise.all([
      loadShell(viewer),
      loadSavedView(supabase, lab.id).then(async (saved) => ({ saved, view: await loadHubView(supabase, lab.id, saved) })),
    ]);
    return (
      <AppShell shell={shell} location={{ section: "map" }}>
        <MapView mode={{ kind: "global", view, saved }} />
      </AppShell>
    );
  }
  const depth = depthOf(one(params.depth));
  if (!LocalQuery.safeParse({ around, depth, similar: false, tags: false }).success) notFound();
  const [shell, { saved, view }] = await Promise.all([
    loadShell(viewer),
    loadSavedView(supabase, lab.id).then(async (saved) => {
      const q = LocalQuery.parse({ around, depth, similar: saved.similar, tags: saved.tags });
      return { saved, view: await loadLocalView(supabase, lab.id, q) };
    }),
  ]);
  const center = view?.nodes.find((n) => n.id === view.center);
  if (view === null || center === undefined) notFound();
  return (
    <AppShell shell={shell} location={{ section: "map" }}>
      <MapView mode={{ kind: "local", view, centerName: nodeName(center), saved }} />
    </AppShell>
  );
}
