import { describe, expect, it } from "vitest";
import { ALL_KINDS, globalGraph, HubFiles, HubView, MapNodeId, type Graph, type MapEdge, type MapNode } from "../map";
import { Sha256 } from "../ids";
import { bounds, createLayout, hold, isSettled, MAX_LAYOUT_NODES, nodeAt, release, settle, tick } from "../map-layout";

const sha = (n: number) => n.toString(16).padStart(64, "0");
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const id = (s: string) => MapNodeId.parse(s);

// A lab like the pilot's, scaled: hubs with skewed file counts, each file in one experiment and
// most with a person.
function lab(files: number, experiments = 50, people = 15): Graph {
  const hubs = [
    ...Array.from({ length: experiments }, (_, i) => ({ id: `experiment:${uuid(i + 1)}`, kind: "experiment", name: `Experiment ${i}`, files: 0 })),
    ...Array.from({ length: people }, (_, i) => ({ id: `person:${uuid(1000 + i)}`, kind: "person", name: `Person ${i}`, files: 0 })),
  ];
  const view = HubView.parse({ files, linked: files, hubs, links: [] });
  const byHub = new Map<string, { nodes: unknown[]; edges: unknown[] }>();
  for (let f = 0; f < files; f++) {
    const e = hubs[Math.floor(Math.pow(f / files, 2) * experiments)]?.id ?? "";
    const p = hubs[experiments + (f % people)]?.id ?? "";
    const entry = byHub.get(e) ?? { nodes: [], edges: [] };
    entry.nodes.push({ id: `file:${sha(f + 1)}`, kind: "file", name: `run ${f}`, fileKind: "spreadsheet" });
    entry.edges.push({ source: `file:${sha(f + 1)}`, target: e, kind: "label" }, { source: `file:${sha(f + 1)}`, target: p, kind: "label" });
    byHub.set(e, entry);
  }
  const open = [...byHub].map(([hub, v]) => HubFiles.parse({ hub, total: v.nodes.length, ...v }));
  return globalGraph({ view, open, filters: { kinds: ALL_KINDS, similar: false } });
}

function graphOf(nodes: MapNode[], edges: MapEdge[]): Graph {
  return { nodes: new Map(nodes.map((n) => [n.id, n])), edges, center: null };
}

const finite = (a: Float64Array) => a.every((v) => Number.isFinite(v));

describe("the map's layout", () => {
  it("comes to rest within its tick budget, with every position a number", () => {
    const g = lab(600);
    const layout = createLayout(g);
    const ticks = settle(layout, 400);
    expect(isSettled(layout)).toBe(true);
    expect(ticks).toBeLessThanOrEqual(310);
    expect(finite(layout.x) && finite(layout.y)).toBe(true);
  });

  it("is the same every time for the same graph", () => {
    const a = createLayout(lab(200));
    const b = createLayout(lab(200));
    settle(a, 400);
    settle(b, 400);
    expect([...a.x]).toEqual([...b.x]);
  });

  it("keeps nodes on one spot apart and fits a lab in a bounded area", () => {
    const P = id(`protocol:${uuid(1)}`);
    const nodes: MapNode[] = [
      { kind: "protocol", id: P, name: "P", files: 40 },
      ...Array.from({ length: 40 }, (_, i): MapNode => ({ kind: "file", id: id(`file:${sha(i + 1)}`), sha256: Sha256.parse(sha(i + 1)), name: `f${i}`, fileKind: "pdf" })),
    ];
    const edges: MapEdge[] = nodes.slice(1).map((n) => ({ source: n.id, target: P, kind: "attached", weight: 1 }));
    const layout = createLayout(graphOf(nodes, edges));
    layout.x.fill(0);
    layout.y.fill(0);
    settle(layout, 400);
    expect(finite(layout.x)).toBe(true);
    const spots = new Set([...layout.x].map((x, i) => `${x.toFixed(2)},${(layout.y[i] ?? 0).toFixed(2)}`));
    expect(spots.size).toBe(41);
    const b = bounds(layout);
    expect(b.maxX - b.minX).toBeLessThan(400);
  });

  it("draws a hub's files around it, nearer it than other hubs", () => {
    const g = lab(400, 4, 1);
    const layout = createLayout(g);
    settle(layout, 400);
    const at = (s: string) => layout.index.get(id(s)) ?? -1;
    const e0 = at(`experiment:${uuid(1)}`);
    const e3 = at(`experiment:${uuid(4)}`);
    const d = (i: number, j: number) => Math.hypot((layout.x[i] ?? 0) - (layout.x[j] ?? 0), (layout.y[i] ?? 0) - (layout.y[j] ?? 0));
    const own = [...g.edges].filter((e) => e.target === `experiment:${uuid(1)}`).map((e) => at(e.source));
    const nearer = own.filter((f) => d(f, e0) < d(f, e3)).length;
    expect(nearer / own.length).toBeGreaterThan(0.9);
  });

  it("keeps the places it had when a hub opens, and only nudges them", () => {
    const before = createLayout(lab(300));
    settle(before, 400);
    const after = createLayout(lab(330), before);
    expect(after.alpha).toBeLessThan(0.5);
    const i = after.index.get(id(`file:${sha(10)}`)) ?? -1;
    const j = before.index.get(id(`file:${sha(10)}`)) ?? -1;
    expect(after.x[i]).toBe(before.x[j]);
  });

  it("holds a dragged node where the pointer is and lets go", () => {
    const layout = createLayout(lab(100));
    settle(layout, 400);
    hold(layout, 3, 500, -500);
    for (let t = 0; t < 30; t++) tick(layout);
    expect([layout.x[3], layout.y[3]]).toEqual([500, -500]);
    expect(isSettled(layout)).toBe(false);
    release(layout, 3);
    settle(layout, 400);
    expect(isSettled(layout)).toBe(true);
    expect(nodeAt(layout, layout.x[3] ?? 0, layout.y[3] ?? 0, 2)).toBe(3);
    expect(nodeAt(layout, 1e6, 1e6, 2)).toBe(-1);
  });

  it("refuses more nodes than it can lay out in a frame", () => {
    const nodes: MapNode[] = Array.from({ length: MAX_LAYOUT_NODES + 1 }, (_, i) => ({
      kind: "file",
      id: id(`file:${sha(i + 1)}`),
      sha256: Sha256.parse(sha(i + 1)),
      name: "f",
      fileKind: "pdf",
    }));
    expect(() => createLayout(graphOf(nodes, []))).toThrow(/at most/);
  });

  it("ticks a 20,000-file lab in well under a second", () => {
    const layout = createLayout(lab(20_000));
    const start = performance.now();
    for (let t = 0; t < 5; t++) tick(layout);
    const perTick = (performance.now() - start) / 5;
    expect(finite(layout.x)).toBe(true);
    expect(perTick).toBeLessThan(250);
  });
});
