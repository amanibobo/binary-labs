import type { FileKind } from "@/lib/domain";
import { Sha256 } from "@/lib/ids";
import {
  HUB_FILE_LIMIT,
  MapNodeId,
  type FileNode,
  type HubFiles,
  type HubNode,
  type HubQuery,
  type HubsQuery,
  type HubView,
  type LinkKind,
  type LocalQuery,
  type LocalView,
  type MapEdge,
  type MapNode,
  type MapViewSave,
} from "@/lib/map";

// Dev-only: a generated lab for the map's fixture pages, screenshots and the 20,000-file frame
// time measurement. It answers the same three questions lab_map, lab_map_hub and
// lab_map_local answer, worked out the same way from generated labels and links.

// What the fixture pages saved, for tests and screenshots to read.
export const mapSaves: MapViewSave[] = [];

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
// A few tags each experiment's files mostly carry, and some any file might.
const TAGS = [
  "His-tag", "pH 7.4", "pH 8.0", "4 °C", "room temp", "overnight", "time course", "dose response",
  "standard curve", "blank", "triplicate", "pilot", "failed", "redo", "final", "draft",
  "glycerol stock", "induced", "uninduced", "lysate", "elution", "flow-through", "wash", "ladder",
  "Coomassie", "anti-His", "DMSO", "NADPH", "heme", "ligand A", "ligand B", "mutant",
];
const COMMON_TAGS = ["control", "replicate", "repeat"];
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
  // Tags, kept apart from the hubs so the lab without them is the same lab: the tags, each
  // file's, and what lab_map adds with tags or similar on.
  tags: ReadonlyMap<MapNodeId, HubNode>;
  tagLinks: ReadonlyMap<MapNodeId, readonly MapNodeId[]>;
  tagEdges: readonly MapEdge[];
  similarHubEdges: readonly MapEdge[];
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

  // Tags from a generator of their own, so adding them moved nothing else in the lab.
  const tagRand = mulberry32(9157);
  const tags = new Map<MapNodeId, HubNode>();
  const tagId = (name: string) => {
    const id = MapNodeId.parse(`tag:${name.toLowerCase()}`);
    if (!tags.has(id)) tags.set(id, { kind: "tag", id, name, files: 0 });
    return id;
  };
  const pools = new Map(experiments.map((e, i) => [e.id, [0, 1, 2].map((j) => TAGS[(i * 5 + j * 11) % TAGS.length] ?? "pilot")]));
  const tagLinks = new Map<MapNodeId, MapNodeId[]>();
  for (const [file, own] of links) {
    const pool = pools.get(own[0]?.hub ?? MapNodeId.parse("tag:none")) ?? [];
    const mine = new Set<MapNodeId>();
    for (const name of pool) if (tagRand() < 0.35) mine.add(tagId(name));
    if (tagRand() < 0.1) mine.add(tagId(COMMON_TAGS[Math.floor(tagRand() * COMMON_TAGS.length)] ?? "control"));
    if (mine.size > 0) tagLinks.set(file, [...mine]);
  }

  const hubFiles = new Map<MapNodeId, MapNodeId[]>();
  const fileOf = (hub: MapNodeId, file: MapNodeId) => {
    const list = hubFiles.get(hub) ?? [];
    list.push(file);
    hubFiles.set(hub, list);
  };
  for (const [file, own] of links) for (const { hub } of own) fileOf(hub, file);
  for (const [file, own] of tagLinks) for (const tag of own) fileOf(tag, file);
  for (const [hub, list] of hubFiles) {
    list.reverse();
    const node = hubs.get(hub);
    if (node !== undefined) hubs.set(hub, { ...node, files: list.length });
    const tag = tags.get(hub);
    if (tag !== undefined) tags.set(hub, { ...tag, files: list.length });
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

  // Each tag on two or more files, by the two hubs it shares most files with, as lab_map does.
  const tagEdges: MapEdge[] = [];
  for (const [tag, node] of tags) {
    if (node.files < 2) continue;
    const by = new Map<MapNodeId, number>();
    for (const file of hubFiles.get(tag) ?? []) for (const { hub } of links.get(file) ?? []) by.set(hub, (by.get(hub) ?? 0) + 1);
    [...by]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .forEach(([hub, n]) => tagEdges.push({ source: tag, target: hub, kind: "shared", weight: n }));
  }

  // Hubs whose files read alike: similar pairs where neither file is in the other's hub.
  const hubsOf = (file: MapNodeId) => new Set((links.get(file) ?? []).map((l) => l.hub));
  const alike = new Map<string, { n: number; total: number }>();
  // A list is directed, so a pair on both files' lists is one pair.
  const filePairs = new Map<string, readonly [MapNodeId, MapNodeId, number]>();
  for (const [a, near] of neighbors) {
    for (const [b, sim] of near) filePairs.set(a < b ? `${a}|${b}` : `${b}|${a}`, a < b ? [a, b, sim] : [b, a, sim]);
  }
  for (const [a, b, sim] of filePairs.values()) {
    const ha = hubsOf(a);
    const hb = hubsOf(b);
    for (const h1 of ha) {
      if (hb.has(h1)) continue;
      for (const h2 of hb) {
        if (h1 === h2 || ha.has(h2)) continue;
        const key = h1 < h2 ? `${h1}|${h2}` : `${h2}|${h1}`;
        const cur = alike.get(key) ?? { n: 0, total: 0 };
        alike.set(key, { n: cur.n + 1, total: cur.total + sim });
      }
    }
  }
  const alikePairs = [...alike].filter(([, v]) => v.n >= 2).map(([k, v]) => {
    const [a = "", b = ""] = k.split("|");
    return { a, b, n: v.n, s: Math.round((v.total / v.n) * 1000) / 1000 };
  });
  const top = (side: "a" | "b") => {
    const by = new Map<string, typeof alikePairs>();
    for (const p of alikePairs) by.set(p[side], [...(by.get(p[side]) ?? []), p]);
    const keep = new Set<string>();
    for (const list of by.values()) list.sort((x, y) => y.n - x.n || y.s - x.s).slice(0, 3).forEach((p) => keep.add(`${p.a}|${p.b}`));
    return keep;
  };
  const keepAlike = new Set([...top("a"), ...top("b")]);
  const similarHubEdges = alikePairs
    .filter((p) => keepAlike.has(`${p.a}|${p.b}`))
    .map((p): MapEdge => ({ source: MapNodeId.parse(p.a), target: MapNodeId.parse(p.b), kind: "similar", similarity: p.s }));

  return { view, hubs, files, links, hubFiles, uses, neighbors, tags, tagLinks, tagEdges, similarHubEdges };
}

export function fixtureHubView(lab: FixtureLab, q: HubsQuery): HubView {
  return {
    ...lab.view,
    hubs: q.tags ? [...lab.view.hubs, ...[...lab.tags.values()].filter((t) => t.files >= 2)] : lab.view.hubs,
    links: [...lab.view.links, ...(q.tags ? lab.tagEdges : []), ...(q.similar ? lab.similarHubEdges : [])],
  };
}

const hubNode = (lab: FixtureLab, id: MapNodeId) => lab.hubs.get(id) ?? lab.tags.get(id);

function edgesAmong(lab: FixtureLab, ids: ReadonlySet<MapNodeId>, similar: boolean): MapEdge[] {
  const out: MapEdge[] = [];
  for (const id of ids) {
    for (const { hub, via } of lab.links.get(id) ?? []) if (ids.has(hub)) out.push({ source: id, target: hub, kind: via, weight: 1 });
    for (const tag of lab.tagLinks.get(id) ?? []) if (ids.has(tag)) out.push({ source: id, target: tag, kind: "label", weight: 1 });
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
  const ids = new Set<MapNodeId>([...mine, ...others, ...lab.hubs.keys(), ...(q.tags ? lab.tags.keys() : []), q.id]);
  const own = new Set(mine);
  return {
    hub: q.id,
    total: lab.hubFiles.get(q.id)?.length ?? 0,
    nodes: mine.map((id) => lab.files.get(id)).filter((n): n is FileNode => n !== undefined),
    edges: edgesAmong(lab, ids, q.similar).filter((e) => own.has(e.source) || own.has(e.target)),
  };
}

function step(lab: FixtureLab, from: readonly MapNodeId[], perHub: number, similar: boolean, tags: boolean): Set<MapNodeId> {
  const out = new Set<MapNodeId>();
  for (const id of from) {
    if (lab.files.has(id)) {
      for (const { hub } of lab.links.get(id) ?? []) out.add(hub);
      if (tags) for (const tag of lab.tagLinks.get(id) ?? []) out.add(tag);
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
  const center = lab.files.get(q.around) ?? hubNode(lab, q.around);
  if (center === undefined) return null;
  const all = new Set<MapNodeId>([q.around]);
  let frontier: MapNodeId[] = [q.around];
  for (let d = 1; d <= q.depth; d++) {
    const next = [...step(lab, frontier, d === 1 ? 150 : 24, q.similar, q.tags)].filter((id) => !all.has(id));
    next.forEach((id) => all.add(id));
    frontier = next;
  }
  const nodes = [...all].map((id): MapNode | undefined => lab.files.get(id) ?? hubNode(lab, id)).filter((n): n is FileNode | HubNode => n !== undefined);
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
