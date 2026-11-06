import { z } from "zod";
import { FileKind } from "./domain";
import { KIND_LABELS } from "./format";
import { ProtocolId, Sha256 } from "./ids";

// The lab map (decisions.md, "the lab map"): what lab_map, lab_map_hub and lab_map_local in
// db/migrations/0016_lab_map.sql return, parsed once here, and the graph the map draws from
// them. Node ids are the database's: file:<sha256>, protocol:<uuid>, experiment:<uuid>,
// person:<uuid> and instrument:<lowercased name>.

export const HUB_KINDS = ["protocol", "experiment", "person", "instrument"] as const;
export const HubKind = z.enum(HUB_KINDS);
export type HubKind = z.infer<typeof HubKind>;

export const NODE_KINDS = [...HUB_KINDS, "file"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const MapNodeId = z
  .string()
  .regex(/^(more:)?(file:[0-9a-f]{64}|(protocol|experiment|person):[0-9a-f-]{36}|instrument:.{1,120})$/, "expected a map node id")
  .brand<"MapNodeId">();
export type MapNodeId = z.infer<typeof MapNodeId>;

export type HubNode = { kind: HubKind; id: MapNodeId; name: string; files: number };
export type FileNode = { kind: "file"; id: MapNodeId; sha256: Sha256; name: string; fileKind: FileKind };
// A hub's files the map left out: drawn as one hollow dot, opening them as a search.
export type MoreNode = { kind: "more"; id: MapNodeId; hub: MapNodeId; hubName: string; hidden: number };
export type MapNode = HubNode | FileNode | MoreNode;

// What made a link: a label's experiment, person or instrument; a protocol's attached file,
// chart or talk-through; an experiment's protocol; files two hubs share; or similar meaning.
export const LINK_KINDS = ["label", "attached", "chart", "talk-through", "uses", "shared"] as const;
export type LinkKind = (typeof LINK_KINDS)[number] | "more";
export type MapEdge = { source: MapNodeId; target: MapNodeId } & (
  | { kind: LinkKind; weight: number }
  | { kind: "similar"; similarity: number }
);

const HubNodeWire = z.object({ id: MapNodeId, kind: HubKind, name: z.string(), files: z.number().int().nonnegative() });
const FileNodeWire = z
  .object({ id: MapNodeId, kind: z.literal("file"), name: z.string(), fileKind: FileKind })
  .transform((n, ctx): FileNode => {
    const sha = Sha256.safeParse(n.id.slice("file:".length));
    if (!sha.success) {
      ctx.addIssue({ code: "custom", message: "a file node's id carries its sha256" });
      return z.NEVER;
    }
    return { ...n, sha256: sha.data };
  });
const NodeWire = z.union([FileNodeWire, HubNodeWire]);

const EdgeWire = z
  .object({
    source: MapNodeId,
    target: MapNodeId,
    kind: z.enum([...LINK_KINDS, "similar"]),
    weight: z.number().int().nonnegative().optional(),
    similarity: z.number().min(-1).max(1).optional(),
  })
  .transform((e): MapEdge => {
    if (e.kind === "similar") return { source: e.source, target: e.target, kind: "similar", similarity: e.similarity ?? 0 };
    return { source: e.source, target: e.target, kind: e.kind, weight: e.weight ?? 1 };
  });

// lab_map: the hubs and how they connect.
export const HubView = z.object({
  files: z.number().int().nonnegative(),
  linked: z.number().int().nonnegative(),
  hubs: z.array(HubNodeWire),
  links: z.array(EdgeWire),
});
export type HubView = z.infer<typeof HubView>;

// lab_map_hub: one hub's newest files and every link they have to a hub (and, asked for,
// similar pairs among them and the other open hubs' files).
export const HubFiles = z.object({
  hub: MapNodeId,
  total: z.number().int().nonnegative(),
  nodes: z.array(FileNodeWire),
  edges: z.array(EdgeWire),
});
export type HubFiles = z.infer<typeof HubFiles>;

// lab_map_local: everything within one or two steps of one node.
export const LocalView = z.object({
  center: MapNodeId,
  depth: z.union([z.literal(1), z.literal(2)]),
  nodes: z.array(NodeWire),
  edges: z.array(EdgeWire),
  more: z.array(z.object({ hub: MapNodeId, hidden: z.number().int().positive() })),
});
export type LocalView = z.infer<typeof LocalView>;

export type Depth = LocalView["depth"];

// The most files one hub opens with on the lab map; the rest are offered as a search.
export const HUB_FILE_LIMIT = 400;

export const KIND_NAMES = {
  protocol: { one: "Protocol", many: "Protocols" },
  experiment: { one: "Experiment", many: "Experiments" },
  person: { one: "Person", many: "People" },
  instrument: { one: "Instrument", many: "Instruments" },
  file: { one: "File", many: "Files" },
} satisfies Record<NodeKind, { one: string; many: string }>;

export function kindOf(id: MapNodeId): NodeKind | "more" {
  const prefix = id.slice(0, id.indexOf(":"));
  switch (prefix) {
    case "file":
    case "protocol":
    case "experiment":
    case "person":
    case "instrument":
    case "more":
      return prefix;
    default:
      throw new Error(`not a map node id: ${id}`);
  }
}

// --- The graph the map draws ----------------------------------------------------------

export type Graph = {
  nodes: ReadonlyMap<MapNodeId, MapNode>;
  edges: readonly MapEdge[];
  // The node a local map is centered on.
  center: MapNodeId | null;
};

export type Filters = { kinds: ReadonlySet<NodeKind>; similar: boolean };

export const ALL_KINDS: ReadonlySet<NodeKind> = new Set(NODE_KINDS);

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export const filesText = (n: number) => plural(n, "file", "files");

const moreId = (hub: MapNodeId) => MapNodeId.parse(`more:${hub}`);

function moreNode(hub: HubNode, hidden: number): MoreNode {
  return { kind: "more", id: moreId(hub.id), hub: hub.id, hubName: hub.name, hidden };
}

const edgeKey = (e: MapEdge) => `${e.source}|${e.target}|${e.kind === "similar" ? "s" : "l"}`;

// Keeps edges whose ends are both drawn, once each, and drops hidden kinds; a file left with
// no link at all is dropped too, unless it's the center.
function assemble(nodes: Map<MapNodeId, MapNode>, edges: Iterable<MapEdge>, filters: Filters, center: MapNodeId | null): Graph {
  for (const [id, node] of nodes) {
    const kind = node.kind === "more" ? "file" : node.kind;
    if (!filters.kinds.has(kind) && id !== center) nodes.delete(id);
  }
  const seen = new Map<string, MapEdge>();
  for (const e of edges) {
    if (e.kind === "similar" && !filters.similar) continue;
    if (!nodes.has(e.source) || !nodes.has(e.target) || e.source === e.target) continue;
    const key = edgeKey(e);
    const reverse = edgeKey({ ...e, source: e.target, target: e.source });
    if (!seen.has(key) && !seen.has(reverse)) seen.set(key, e);
  }
  const linked = new Set<MapNodeId>();
  for (const e of seen.values()) {
    linked.add(e.source);
    linked.add(e.target);
  }
  for (const [id, node] of nodes) {
    if (node.kind !== "file" && node.kind !== "more") continue;
    if (!linked.has(id) && id !== center) nodes.delete(id);
  }
  return { nodes, edges: [...seen.values()], center };
}

// The lab map: every hub, plus the files of the hubs someone opened.
export function globalGraph({ view, open, filters }: { view: HubView; open: readonly HubFiles[]; filters: Filters }): Graph {
  const nodes = new Map<MapNodeId, MapNode>(view.hubs.map((h) => [h.id, h]));
  const edges: MapEdge[] = [...view.links];
  for (const hub of open) {
    const node = nodes.get(hub.hub);
    if (node === undefined || node.kind === "file" || node.kind === "more") continue;
    for (const file of hub.nodes) nodes.set(file.id, file);
    edges.push(...hub.edges);
    const hidden = hub.total - hub.nodes.length;
    if (hidden > 0) {
      const more = moreNode(node, hidden);
      nodes.set(more.id, more);
      edges.push({ source: more.id, target: node.id, kind: "more", weight: 1 });
    }
  }
  return assemble(nodes, edges, filters, null);
}

// The map around one thing.
export function localGraph({ view, filters }: { view: LocalView; filters: Filters }): Graph {
  const nodes = new Map<MapNodeId, MapNode>(view.nodes.map((n) => [n.id, n]));
  const edges: MapEdge[] = [...view.edges];
  for (const { hub, hidden } of view.more) {
    const node = nodes.get(hub);
    if (node === undefined || node.kind === "file" || node.kind === "more") continue;
    const more = moreNode(node, hidden);
    nodes.set(more.id, more);
    edges.push({ source: more.id, target: node.id, kind: "more", weight: 1 });
  }
  return assemble(nodes, edges, filters, nodes.has(view.center) ? view.center : null);
}

export type Adjacency = ReadonlyMap<MapNodeId, readonly MapNodeId[]>;

export function adjacency(graph: Graph): Adjacency {
  const out = new Map<MapNodeId, MapNodeId[]>();
  for (const id of graph.nodes.keys()) out.set(id, []);
  for (const e of graph.edges) {
    out.get(e.source)?.push(e.target);
    out.get(e.target)?.push(e.source);
  }
  return out;
}

// Every node within `depth` steps of `from`, itself included.
export function neighborhood(adj: Adjacency, from: MapNodeId, depth: number): Set<MapNodeId> {
  const seen = new Set<MapNodeId>([from]);
  let frontier: MapNodeId[] = [from];
  for (let step = 0; step < depth && frontier.length > 0; step++) {
    const next: MapNodeId[] = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

// Name matches among the drawn nodes: whole-name starts first, then word starts, then anywhere.
export function findNodes(graph: Graph, query: string, limit = 8): MapNode[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const scored: { node: MapNode; score: number }[] = [];
  for (const node of graph.nodes.values()) {
    if (node.kind === "more") continue;
    const name = node.name.toLowerCase();
    const at = name.indexOf(q);
    if (at < 0) continue;
    const score = at === 0 ? 0 : /[\s_\-./(]/.test(name[at - 1] ?? "") ? 1 : 2;
    scored.push({ node, score: score * 10 + (node.kind === "file" ? 1 : 0) });
  }
  scored.sort((a, b) => a.score - b.score || a.node.name.localeCompare(b.node.name));
  return scored.slice(0, limit).map((s) => s.node);
}

// --- Words and links ------------------------------------------------------------------

export function describe(node: MapNode): string {
  switch (node.kind) {
    case "file":
      return KIND_LABELS[node.fileKind];
    case "more":
      return `${filesText(node.hidden)} more in ${node.hubName}`;
    case "protocol":
    case "experiment":
    case "person":
    case "instrument":
      return `${KIND_NAMES[node.kind].one} · ${filesText(node.files)}`;
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

export function nodeName(node: MapNode): string {
  return node.kind === "more" ? `${filesText(node.hidden)} more` : node.name;
}

const search = (q: string, open?: Sha256) => `/?${new URLSearchParams(open === undefined ? { q } : { q, open })}`;

// Where a node opens, the way the rest of the app opens it: a file's row in search, a
// protocol's page, and the files of an experiment, person or instrument as a search.
export function openHref(node: MapNode): string {
  switch (node.kind) {
    case "file":
      return search(node.name, node.sha256);
    case "protocol":
      return `/protocols/${ProtocolId.parse(node.id.slice("protocol:".length))}`;
    case "experiment":
    case "person":
    case "instrument":
      return search(node.name);
    case "more":
      return search(node.hubName);
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

export function openLabel(node: MapNode): string {
  switch (node.kind) {
    case "file":
      return "Open file";
    case "protocol":
      return "Open protocol";
    case "experiment":
    case "person":
    case "instrument":
    case "more":
      return "Search its files";
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

export function localMapHref(id: MapNodeId, depth: Depth = 1): string {
  const params = new URLSearchParams({ around: id });
  if (depth === 2) params.set("depth", "2");
  return `/map?${params}`;
}

export const fileNodeId = (sha: Sha256) => MapNodeId.parse(`file:${sha}`);
export const protocolNodeId = (id: ProtocolId) => MapNodeId.parse(`protocol:${id}`);
export const experimentNodeId = (id: string) => MapNodeId.parse(`experiment:${id}`);

// The list view: every drawn node by kind, each with what it links to, for screen readers
// and for anyone who'd rather read than look.
export type ListSection = { kind: NodeKind; title: string; items: { node: MapNode; links: MapNode[] }[] };

export function listSections(graph: Graph): ListSection[] {
  const adj = adjacency(graph);
  const order: NodeKind[] = ["protocol", "experiment", "person", "instrument", "file"];
  return order
    .map((kind): ListSection => {
      const items = [...graph.nodes.values()]
        .filter((n) => (n.kind === "more" ? "file" : n.kind) === kind)
        .map((node) => ({
          node,
          links: (adj.get(node.id) ?? [])
            .map((id) => graph.nodes.get(id))
            .filter((n): n is MapNode => n !== undefined)
            .sort((a, b) => nodeName(a).localeCompare(nodeName(b))),
        }))
        .sort((a, b) => (a.node.kind === "more" ? 1 : 0) - (b.node.kind === "more" ? 1 : 0) || nodeName(a.node).localeCompare(nodeName(b.node)));
      return { kind, title: KIND_NAMES[kind].many, items };
    })
    .filter((s) => s.items.length > 0);
}
