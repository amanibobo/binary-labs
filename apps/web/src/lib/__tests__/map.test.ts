import { describe, expect, it } from "vitest";
import {
  ALL_KINDS,
  adjacency,
  findNodes,
  globalGraph,
  HubFiles,
  HubView,
  listSections,
  localGraph,
  localMapHref,
  LocalView,
  MapNodeId,
  neighborhood,
  openHref,
  type Filters,
  type MapNode,
  type NodeKind,
} from "../map";

const sha = (n: number) => n.toString(16).padStart(64, "0");
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const id = (s: string) => MapNodeId.parse(s);

const P = `protocol:${uuid(1)}`;
const E = `experiment:${uuid(2)}`;
const E2 = `experiment:${uuid(3)}`;
const H = `person:${uuid(4)}`;
const I = "instrument:spectramax m5";
const F1 = `file:${sha(1)}`;
const F2 = `file:${sha(2)}`;
const F3 = `file:${sha(3)}`;

// What lab_map answers, as JSON.
const hubView = HubView.parse({
  files: 3,
  linked: 3,
  hubs: [
    { id: P, kind: "protocol", name: "Ni-NTA purification", files: 1 },
    { id: E, kind: "experiment", name: "P450 batch 3", files: 3 },
    { id: E2, kind: "experiment", name: "Lysozyme DSF", files: 0 },
    { id: H, kind: "person", name: "Priya", files: 2 },
    { id: I, kind: "instrument", name: "SpectraMax M5", files: 1 },
  ],
  links: [
    { source: E, target: P, kind: "uses", weight: 1 },
    { source: E, target: H, kind: "shared", weight: 2 },
  ],
});

const hubFiles = HubFiles.parse({
  hub: E,
  total: 5,
  nodes: [
    { id: F1, kind: "file", name: "Batch 3 gel", fileKind: "image" },
    { id: F2, kind: "file", name: "plate7_A420.csv", fileKind: "spreadsheet" },
    { id: F3, kind: "file", name: "Ni-NTA notes", fileKind: "text" },
  ],
  edges: [
    { source: F1, target: E, kind: "label" },
    { source: F2, target: E, kind: "label" },
    { source: F3, target: E, kind: "label" },
    { source: F1, target: H, kind: "label" },
    { source: F2, target: I, kind: "label" },
    { source: F3, target: P, kind: "attached" },
    { source: F1, target: F2, kind: "similar", similarity: 0.91 },
  ],
});

const filters = (kinds: Iterable<NodeKind> = ALL_KINDS, similar = false): Filters => ({ kinds: new Set(kinds), similar });

describe("parsing what the database answers", () => {
  it("reads a file node's sha256 from its id and refuses ids that aren't node ids", () => {
    const f = hubFiles.nodes[0];
    expect(f?.sha256).toBe(sha(1));
    expect(MapNodeId.safeParse("protocol:not-a-uuid").success).toBe(false);
    expect(MapNodeId.safeParse("folder:/P450").success).toBe(false);
    expect(HubFiles.safeParse({ ...hubFiles, nodes: [{ id: P, kind: "file", name: "x", fileKind: "pdf" }] }).success).toBe(false);
  });

  it("gives link edges a weight and similar edges their similarity", () => {
    expect(hubFiles.edges.find((e) => e.kind === "label")).toMatchObject({ weight: 1 });
    expect(hubFiles.edges.find((e) => e.kind === "similar")).toMatchObject({ similarity: 0.91 });
  });
});

describe("the lab map", () => {
  it("starts as the hubs alone, files arriving only with an opened hub", () => {
    const g = globalGraph({ view: hubView, open: [], filters: filters() });
    expect([...g.nodes.keys()].sort()).toEqual([E, E2, H, I, P].sort());
    expect(g.edges).toHaveLength(2);
  });

  it("opens a hub's files with their links to every drawn hub, and counts the ones left out", () => {
    const g = globalGraph({ view: hubView, open: [hubFiles], filters: filters() });
    expect(g.nodes.has(id(F1)) && g.nodes.has(id(F3))).toBe(true);
    const more = g.nodes.get(id(`more:${E}`));
    expect(more).toMatchObject({ kind: "more", hidden: 2, hubName: "P450 batch 3" });
    const fileEdges = g.edges.filter((e) => e.source.startsWith("file:"));
    // Similar edges stay off until asked for.
    expect(fileEdges.map((e) => e.kind).sort()).toEqual(["attached", "label", "label", "label", "label", "label"]);
    const withSimilar = globalGraph({ view: hubView, open: [hubFiles], filters: filters(ALL_KINDS, true) });
    expect(withSimilar.edges.filter((e) => e.kind === "similar")).toHaveLength(1);
  });

  it("hides a kind and the files it alone held on the map", () => {
    const people = globalGraph({ view: hubView, open: [hubFiles], filters: filters(["protocol", "experiment", "instrument", "file"]) });
    expect(people.nodes.has(id(H))).toBe(false);
    expect(people.edges.some((e) => e.target === H || e.source === H)).toBe(false);
    const noExperiments = globalGraph({ view: hubView, open: [hubFiles], filters: filters(["protocol", "person", "instrument", "file"]) });
    // F1 still links Priya, F2 the plate reader, F3 the protocol; the more node had only its hub.
    expect([...noExperiments.nodes.keys()].filter((k) => k.startsWith("file:")).sort()).toEqual([F1, F2, F3].sort());
    expect(noExperiments.nodes.has(id(`more:${E}`))).toBe(false);
    const noFiles = globalGraph({ view: hubView, open: [hubFiles], filters: filters(["protocol", "experiment", "person", "instrument"]) });
    expect([...noFiles.nodes.values()].some((n) => n.kind === "file" || n.kind === "more")).toBe(false);
  });

  it("draws an edge once even when both directions arrive", () => {
    const twice = HubFiles.parse({ ...hubFiles, edges: [...hubFiles.edges, { source: E, target: F1, kind: "label" }] });
    const g = globalGraph({ view: hubView, open: [twice, twice], filters: filters() });
    expect(g.edges.filter((e) => (e.source === F1 && e.target === E) || (e.source === E && e.target === F1))).toHaveLength(1);
  });
});

describe("a local map", () => {
  const local = LocalView.parse({
    center: F1,
    depth: 1,
    nodes: [
      { id: F1, kind: "file", name: "Batch 3 gel", fileKind: "image" },
      { id: E, kind: "experiment", name: "P450 batch 3", files: 3 },
      { id: H, kind: "person", name: "Priya", files: 2 },
    ],
    edges: [
      { source: F1, target: E, kind: "label" },
      { source: F1, target: H, kind: "label" },
    ],
    more: [{ hub: E, hidden: 2 }],
  });

  it("keeps its center whatever is filtered", () => {
    const g = localGraph({ view: local, filters: filters(["person"]) });
    expect(g.center).toBe(F1);
    expect([...g.nodes.keys()].sort()).toEqual([F1, H].sort());
  });

  it("finds what's one and two steps out", () => {
    const g = localGraph({ view: local, filters: filters() });
    const adj = adjacency(g);
    expect([...neighborhood(adj, id(H), 1)].sort()).toEqual([F1, H].sort());
    expect(neighborhood(adj, id(H), 2).has(id(E))).toBe(true);
  });
});

describe("words and links", () => {
  const g = globalGraph({ view: hubView, open: [hubFiles], filters: filters() });
  const node = (k: string): MapNode => {
    const n = g.nodes.get(id(k));
    if (n === undefined) throw new Error(k);
    return n;
  };

  it("opens each node the way the rest of the app does", () => {
    expect(openHref(node(F2))).toBe(`/?q=plate7_A420.csv&open=${sha(2)}`);
    expect(openHref(node(P))).toBe(`/protocols/${uuid(1)}`);
    expect(openHref(node(E))).toBe("/?q=P450+batch+3");
    expect(openHref(node(`more:${E}`))).toBe("/?q=P450+batch+3");
    expect(localMapHref(id(P), 2)).toBe(`/map?around=protocol%3A${uuid(1)}&depth=2`);
  });

  it("finds nodes by name, starts of names first", () => {
    expect(findNodes(g, "p450").map((n) => n.name)).toEqual(["P450 batch 3"]);
    // Both start with it; the protocol, a hub, comes before the file.
    expect(findNodes(g, "ni").map((n) => n.name)).toEqual(["Ni-NTA purification", "Ni-NTA notes"]);
    expect(findNodes(g, "gel").map((n) => n.name)).toEqual(["Batch 3 gel"]);
    expect(findNodes(g, "  ")).toEqual([]);
  });

  it("lists every node by kind with what it links to", () => {
    const sections = listSections(g);
    expect(sections.map((s) => s.title)).toEqual(["Protocols", "Experiments", "People", "Instruments", "Files"]);
    const files = sections.find((s) => s.kind === "file");
    expect(files?.items.at(-1)?.node.kind).toBe("more");
    const gel = files?.items.find((i) => i.node.id === F1);
    expect(gel?.links.map((n) => n.id).sort()).toEqual([E, H].sort());
  });
});
