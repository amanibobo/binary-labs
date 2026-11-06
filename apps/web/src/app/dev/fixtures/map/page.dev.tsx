import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { MapView, type MapMode } from "@/components/map/map-view";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { biggestHub, fixtureLab, fixtureLocal, PILOT_LAB, SMALL_LAB } from "@/fixtures/map";
import { MapNodeId, nodeName } from "@/lib/map";

// The lab map on a generated lab: ?view=default (the hubs), expanded (the biggest experiment's
// files), similar (that and the biggest person's, with similar in meaning on), local (around one
// file), local2 (two steps around it), protocol (around a protocol). ?size=pilot is the
// pilot's 20,000 files; with ?open=all every hub starts open, for the frame time measurement.
const View = z.enum(["default", "expanded", "similar", "local", "local2", "protocol"]).catch("default");
const Size = z.enum(["small", "pilot"]).catch("small");

export default async function MapFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const params = await searchParams;
  const view = View.parse(params.view);
  const size = Size.parse(params.size) === "pilot" ? PILOT_LAB : SMALL_LAB;
  const lab = fixtureLab(size);
  const experiment = biggestHub(lab, "experiment");
  const person = biggestHub(lab, "person");
  const file = lab.hubFiles.get(experiment)?.[3] ?? MapNodeId.parse(`file:${"1".padStart(64, "0")}`);
  const local = (around: MapNodeId, depth: 1 | 2): MapMode => {
    const v = fixtureLocal(lab, { around, depth, similar: false });
    const center = v?.nodes.find((n) => n.id === around);
    if (v === null || center === undefined) throw new Error("no such fixture node");
    return { kind: "local", view: v, centerName: nodeName(center) };
  };
  const mode: MapMode = (() => {
    switch (view) {
      case "default":
        return { kind: "global", view: lab.view, open: params.open === "all" ? [...lab.hubs.keys()] : [] };
      case "expanded":
        return { kind: "global", view: lab.view, open: [experiment] };
      case "similar":
        return { kind: "global", view: lab.view, open: [experiment, person], similar: true };
      case "local":
        return local(file, 1);
      case "local2":
        return local(file, 2);
      case "protocol":
        return local(biggestHub(lab, "protocol"), 1);
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
