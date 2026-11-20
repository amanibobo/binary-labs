import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { MapView, type MapMode } from "@/components/map/map-view";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { biggestHub, fixtureHubView, fixtureLab, fixtureLocal, PILOT_LAB, SMALL_LAB } from "@/fixtures/map";
import { DEFAULT_MAP_VIEW, flag, MapNodeId, nodeName, type SavedMapView } from "@/lib/map";

// The lab map on a generated lab: ?view=default (the hubs), expanded (the biggest experiment's
// files), similar (that and the biggest person's, with similar in meaning on), tags (the hubs
// with tags on), tagged (the biggest experiment's files and their tags), remembered (opened as
// someone left it: zoomed in on the biggest experiment, its files open), local (around one
// file), local2 (two steps around it), protocol (around a protocol), tag (around the biggest
// tag). ?size=pilot is the pilot's 20,000 files; ?open=all opens every hub, and ?similar=1 and
// ?tags=1 turn those on, for the frame time measurement.
const View = z.enum(["default", "expanded", "similar", "tags", "tagged", "remembered", "local", "local2", "protocol", "tag"]).catch("default");
const Size = z.enum(["small", "pilot"]).catch("small");
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function MapFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const params = await searchParams;
  const view = View.parse(params.view);
  const size = Size.parse(params.size) === "pilot" ? PILOT_LAB : SMALL_LAB;
  const lab = fixtureLab(size);
  const experiment = biggestHub(lab, "experiment");
  const person = biggestHub(lab, "person");
  const file = lab.hubFiles.get(experiment)?.[3] ?? MapNodeId.parse(`file:${"1".padStart(64, "0")}`);
  const switches = { similar: flag(one(params.similar)), tags: flag(one(params.tags)) };
  const global = (saved: Partial<SavedMapView>): MapMode => {
    const s: SavedMapView = { ...DEFAULT_MAP_VIEW, ...switches, ...saved };
    return { kind: "global", view: fixtureHubView(lab, s), saved: s };
  };
  const local = (around: MapNodeId, depth: 1 | 2, saved: Partial<SavedMapView> = {}): MapMode => {
    const s: SavedMapView = { ...DEFAULT_MAP_VIEW, ...switches, ...saved };
    const v = fixtureLocal(lab, { around, depth, similar: s.similar, tags: s.tags });
    const center = v?.nodes.find((n) => n.id === around);
    if (v === null || center === undefined) throw new Error("no such fixture node");
    return { kind: "local", view: v, centerName: nodeName(center), saved: s };
  };
  const biggestTag = [...lab.tags.values()].sort((a, b) => b.files - a.files)[0]?.id ?? experiment;
  const mode: MapMode = (() => {
    switch (view) {
      case "default":
        return global({ open: one(params.open) === "all" ? [...lab.hubs.keys()] : [] });
      case "expanded":
        return global({ open: [experiment] });
      case "similar":
        return global({ open: [experiment, person], similar: true });
      case "tags":
        return global({ tags: true });
      case "tagged":
        return global({ open: [experiment], tags: true });
      case "remembered":
        return global({ open: [experiment], camera: { anchor: experiment, k: 2.2, dx: 0, dy: 0 } });
      case "local":
        return local(file, 1);
      case "local2":
        return local(file, 2);
      case "protocol":
        return local(biggestHub(lab, "protocol"), 1);
      case "tag":
        return local(biggestTag, 1, { tags: true });
      default: {
        const _exhaustive: never = view;
        return _exhaustive;
      }
    }
  })();
  return (
    <FixtureLabApi mode="hybrid" source={doneSource} mapSize={size}>
      <AppShell shell={fixtureShell} location={{ section: "map" }}>
        <MapView mode={mode} />
      </AppShell>
    </FixtureLabApi>
  );
}
