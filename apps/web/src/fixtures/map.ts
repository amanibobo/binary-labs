import type { FileKind } from "@/lib/domain";
import { Sha256 } from "@/lib/ids";
import {
  HUB_FILE_LIMIT,
  MapNodeId,
  type FileNode,
  type HubFiles,
  type HubNode,
  type HubQuery,
  type HubView,
  type LinkKind,
  type LocalQuery,
  type LocalView,
  type MapEdge,
  type MapNode,
} from "@/lib/map";

// Dev-only: a generated lab for the map's fixture pages, screenshots and the 20,000-file frame
// time measurement. It answers the same three questions lab_map, lab_map_hub and
// lab_map_local answer, worked out the same way from generated labels and links.

const PROTOCOLS = [
  "Ni-NTA purification",
  "SDS-PAGE, Bis-Tris 12%",
  "Thermal shift (DSF)",
  "Bradford assay",
  "SEC on Superdex 200",
  "Plate reader kinetics",
  "Crystal tray setup",
  "Heat-shock transformation",
  "Western blot",
  "Dialysis and buffer exchange",
  "Buffer recipes",
  "Competent cells",
];
const EXPERIMENTS = [
  "P450 batch 3",
  "P450 batch 2",
  "Lysozyme DSF",
  "BM3 mutants",
  "Screen plate 07",
  "P450 batch 1",
  "Lysozyme crystals",
  "Heme titration",
  "BM3 kinetics",
  "NADPH coupling",
  "Thermal screen 2",
  "His-tag cleavage",
  "Rotation project",
  "CYP102 variants",
  "Ligand soak",
  "Stability panel",
];
const PEOPLE = ["Priya Raman", "Ade Okafor", "Sam Chen", "Rosa Díaz", "Mei Tanaka", "Jonas Berg", "Lena Novak", "Omar Haddad"];
const INSTRUMENTS = ["SpectraMax M5", "AKTA pure", "QuantStudio 5", "NanoDrop One"];
const KINDS: { what: string; fileKind: FileKind }[] = [
  { what: "plate read", fileKind: "spreadsheet" },
  { what: "gel", fileKind: "image" },
  { what: "SEC trace", fileKind: "spreadsheet" },
  { what: "notes", fileKind: "document" },
];

type Link = { hub: MapNodeId; via: LinkKind };

export type FixtureLab = {
  view: HubView;
  hubs: ReadonlyMap<MapNodeId, HubNode>;
  files: ReadonlyMap<MapNodeId, FileNode>;
  links: ReadonlyMap<MapNodeId, readonly Link[]>;
  // Each hub's files, newest first.
  hubFiles: ReadonlyMap<MapNodeId, readonly MapNodeId[]>;
  // Experiment to its protocol.
  uses: ReadonlyMap<MapNodeId, MapNodeId>;
  neighbors: ReadonlyMap<MapNodeId, readonly (readonly [MapNodeId, number])[]>;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uuid = (group: number, n: number) => `00000000-0000-4000-8${group}00-${n.toString().padStart(12, "0")}`;
const named = (list: readonly string[], i: number, what: string) => list[i] ?? `${what} ${i + 1}`;

export type LabSize = { files: number; protocols: number; experiments: number; people: number; instruments: number };
// What the screenshots show, and the pilot lab's size for the frame time measurement.
export const SMALL_LAB: LabSize = { files: 900, protocols: 12, experiments: 16, people: 8, instruments: 4 };
export const PILOT_LAB: LabSize = { files: 20_000, protocols: 30, experiments: 50, people: 15, instruments: 4 };

export function fixtureLab(size: LabSize = SMALL_LAB): FixtureLab {
  const rand = mulberry32(4821);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const hubs = new Map<MapNodeId, HubNode>();
  const add = (kind: HubNode["kind"], id: string, name: string) => {
    const node: HubNode = { kind, id: MapNodeId.parse(id), name, files: 0 };
    hubs.set(node.id, node);
    return node;
  };
  const protocols = Array.from({ length: size.protocols }, (_, i) => add("protocol", `protocol:${uuid(1, i + 1)}`, named(PROTOCOLS, i, "Protocol")));
  const experiments = Array.from({ length: size.experiments }, (_, i) =>
    add("experiment", `experiment:${uuid(2, i + 1)}`, named(EXPERIMENTS, i, "Experiment")),
  );
  const people = Array.from({ length: size.people }, (_, i) => add("person", `person:${uuid(3, i + 1)}`, named(PEOPLE, i, "Person")));
  const instruments = Array.from({ length: size.instruments }, (_, i) => {
    const name = named(INSTRUMENTS, i, "Instrument");
    return add("instrument", `instrument:${name.toLowerCase()}`, name);
  });
  const uses = new Map<MapNodeId, MapNodeId>();
  experiments.forEach((e, i) => {
    const p = protocols[(i * 7) % protocols.length];
    if (p !== undefined && i % 5 !== 4) uses.set(e.id, p.id);
  });
  // Each experiment is mostly one or two people's, on one or two instruments.
  const plan = experiments.map((e, i) => ({
    e,
    leads: [people[i % people.length], people[(i * 3 + 1) % people.length]].filter((p): p is HubNode => p !== undefined),
    tools: [instruments[i % instruments.length], instruments[(i + 2) % instruments.length]].filter((x): x is HubNode => x !== undefined),
    weight: 1 / Math.pow(i + 1, 0.8),
  }));
  const total = plan.reduce((t, p) => t + p.weight, 0);

  const files = new Map<MapNodeId, FileNode>();
  const links = new Map<MapNodeId, Link[]>();
  const groups = new Map<string, MapNodeId[]>();
  const counter = new Map<string, number>();
  for (let f = 0; f < size.files; f++) {
    let r = rand() * total;
    const p = plan.find((x) => (r -= x.weight) < 0) ?? plan[0];
    if (p === undefined) break;
    const kind = Math.floor(rand() * KINDS.length);
    const k = KINDS[kind] ?? KINDS[0];
    if (k === undefined) break;
    const key = `${p.e.id}|${kind}`;
    const n = (counter.get(key) ?? 0) + 1;
    counter.set(key, n);
    const sha = Sha256.parse((f + 1).toString(16).padStart(64, "0"));
    const id = MapNodeId.parse(`file:${sha}`);
    files.set(id, { kind: "file", id, sha256: sha, name: `${p.e.name} ${k.what} ${n}`, fileKind: k.fileKind });
    const own: Link[] = [{ hub: p.e.id, via: "label" }];
    const person = rand() < 0.85 ? pick(p.leads) : pick(people);
    if (person !== undefined && rand() < 0.92) own.push({ hub: person.id, via: "label" });
    if (k.fileKind !== "document" && rand() < 0.7) {
      const tool = pick(p.tools);
      if (tool !== undefined) own.push({ hub: tool.id, via: "label" });
    }
    const protocol = uses.get(p.e.id);
    if (protocol !== undefined && rand() < 0.03) own.push({ hub: protocol, via: k.fileKind === "spreadsheet" && rand() < 0.3 ? "chart" : "attached" });
    links.set(id, own);
    const g = groups.get(key) ?? [];
    g.push(id);
    groups.set(key, g);
  }

  // Similar in meaning: files of one kind in one experiment, nearest by when they were made;
  // one in five reads like nothing else.
  const neighbors = new Map<MapNodeId, (readonly [MapNodeId, number])[]>();
  for (const g of groups.values()) {
    g.forEach((id, i) => {
      if (mulberry32(i * 31 + g.length)() < 0.2) return;
      const near: (readonly [MapNodeId, number])[] = [];
      for (let d = 1; near.length < 5 && d < 8; d++) {
        for (const j of [i - d, i + d]) {
          const other = g[j];
          if (other !== undefined && near.length < 5) near.push([other, Math.round((0.97 - 0.025 * d) * 1000) / 1000]);
        }
      }
      neighbors.set(id, near);
    });
  }

  const hubFiles = new Map<MapNodeId, MapNodeId[]>();
  for (const [file, own] of links) {
    for (const { hub } of own) {
      const list = hubFiles.get(hub) ?? [];
      list.push(file);
      hubFiles.set(hub, list);
    }
  }
  for (const [hub, list] of hubFiles) {
    list.reverse();
    const node = hubs.get(hub);
    if (node !== undefined) hubs.set(hub, { ...node, files: list.length });
  }

  // Shared files between hubs, each hub keeping its four strongest, as lab_map does.
  const shared = new Map<string, number>();
  for (const own of links.values()) {
    const ids = own.map((l) => l.hub).sort();
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) shared.set(`${ids[a]}|${ids[b]}`, (shared.get(`${ids[a]}|${ids[b]}`) ?? 0) + 1);
  }
  const isUses = (a: string, b: string) => uses.get(MapNodeId.parse(a)) === b || uses.get(MapNodeId.parse(b)) === a;
  const pairs = [...shared].map(([k, n]) => {
    const [a = "", b = ""] = k.split("|");
    return { a, b, n };
  });
  const rank = (side: "a" | "b") => {
    const by = new Map<string, typeof pairs>();
    for (const p of pairs.filter((p) => !isUses(p.a, p.b))) by.set(p[side], [...(by.get(p[side]) ?? []), p]);
    const keep = new Set<string>();
    for (const list of by.values()) list.sort((x, y) => y.n - x.n).slice(0, 4).forEach((p) => keep.add(`${p.a}|${p.b}`));
    return keep;
  };
  const strongest = new Set([...rank("a"), ...rank("b")]);
  const edges: MapEdge[] = [
    ...[...uses].map(([e, p]): MapEdge => ({ source: e, target: p, kind: "uses", weight: shared.get([e, p].sort().join("|")) ?? 0 })),
    ...pairs
      .filter((p) => strongest.has(`${p.a}|${p.b}`))
      .map((p): MapEdge => ({ source: MapNodeId.parse(p.a), target: MapNodeId.parse(p.b), kind: "shared", weight: p.n })),
  ];
  const view: HubView = {
    files: files.size,
    linked: files.size,
    hubs: [...hubs.values()],
    links: edges,
  };
  return { view, hubs, files, links, hubFiles, uses, neighbors };
}

function edgesAmong(lab: FixtureLab, ids: ReadonlySet<MapNodeId>, similar: boolean): MapEdge[] {
  const out: MapEdge[] = [];
  for (const id of ids) {
    for (const { hub, via } of lab.links.get(id) ?? []) if (ids.has(hub)) out.push({ source: id, target: hub, kind: via, weight: 1 });
    const protocol = lab.uses.get(id);
    if (protocol !== undefined && ids.has(protocol)) out.push({ source: id, target: protocol, kind: "uses", weight: 1 });
    if (similar) {
      for (const [other, s] of lab.neighbors.get(id) ?? []) {
        if (ids.has(other) && id < other) out.push({ source: id, target: other, kind: "similar", similarity: s });
      }
    }
  }
  return out;
}

const newest = (lab: FixtureLab, hub: MapNodeId, n: number) => (lab.hubFiles.get(hub) ?? []).slice(0, n);

export function fixtureHubFiles(lab: FixtureLab, q: HubQuery): HubFiles {
  const mine = newest(lab, q.id, HUB_FILE_LIMIT);
  const others = q.similar ? q.with.flatMap((h) => newest(lab, h, HUB_FILE_LIMIT)) : [];
  const ids = new Set<MapNodeId>([...mine, ...others, ...lab.hubs.keys()]);
  const own = new Set(mine);
  return {
    hub: q.id,
    total: lab.hubFiles.get(q.id)?.length ?? 0,
    nodes: mine.map((id) => lab.files.get(id)).filter((n): n is FileNode => n !== undefined),
    edges: edgesAmong(lab, ids, q.similar).filter((e) => own.has(e.source) || own.has(e.target)),
  };
}

function step(lab: FixtureLab, from: readonly MapNodeId[], perHub: number, similar: boolean): Set<MapNodeId> {
  const out = new Set<MapNodeId>();
  for (const id of from) {
    if (lab.files.has(id)) {
      for (const { hub } of lab.links.get(id) ?? []) out.add(hub);
      if (similar) for (const [other] of lab.neighbors.get(id) ?? []) out.add(other);
      continue;
    }
    for (const f of newest(lab, id, perHub)) out.add(f);
    const protocol = lab.uses.get(id);
    if (protocol !== undefined) out.add(protocol);
    for (const [e, p] of lab.uses) if (p === id) out.add(e);
  }
  return out;
}

export function fixtureLocal(lab: FixtureLab, q: LocalQuery): LocalView | null {
  const center = lab.files.get(q.around) ?? lab.hubs.get(q.around);
  if (center === undefined) return null;
  const all = new Set<MapNodeId>([q.around]);
  let frontier: MapNodeId[] = [q.around];
  for (let d = 1; d <= q.depth; d++) {
    const next = [...step(lab, frontier, d === 1 ? 150 : 24, q.similar)].filter((id) => !all.has(id));
    next.forEach((id) => all.add(id));
    frontier = next;
  }
  const nodes = [...all].map((id): MapNode | undefined => lab.files.get(id) ?? lab.hubs.get(id)).filter((n): n is FileNode | HubNode => n !== undefined);
  const edges = edgesAmong(lab, all, q.similar);
  const more = nodes
    .filter((n): n is HubNode => n.kind !== "file")
    .map((n) => ({ hub: n.id, hidden: n.files - edges.filter((e) => e.target === n.id && e.kind !== "similar" && e.source.startsWith("file:")).length }))
    .filter((m) => m.hidden > 0);
  return { center: q.around, depth: q.depth, nodes, edges, more };
}

export function biggestHub(lab: FixtureLab, kind: HubNode["kind"]): MapNodeId {
  const best = [...lab.hubs.values()].filter((h) => h.kind === kind).sort((a, b) => b.files - a.files)[0];
  if (best === undefined) throw new Error(`no ${kind} in the fixture lab`);
  return best.id;
}
