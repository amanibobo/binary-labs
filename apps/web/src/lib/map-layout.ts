import type { Graph, MapEdge, MapNode, MapNodeId } from "./map";

// A force layout for the lab map, in the spirit of d3-force but sized to what the map needs:
// links pull linked nodes to a rest length, every node pushes every other away (Barnes-Hut,
// so a tick is O(n log n)), and a faint pull to the middle keeps loose pieces near. Positions
// live in typed arrays and a tick mutates them in place; this is the per-frame hot path.

// More nodes than this aren't laid out: the map never opens that many (each hub opens with at
// most HUB_FILE_LIMIT files) and a tick past it takes longer than a frame.
export const MAX_LAYOUT_NODES = 25_000;
export const ALPHA_MIN = 0.002;
// About 300 ticks from a cold start to rest, as d3 does.
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300);
const VELOCITY_DECAY = 0.4;
const THETA2 = 0.81;
const GRAVITY = 0.03;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export type Layout = {
  readonly ids: readonly MapNodeId[];
  readonly index: ReadonlyMap<MapNodeId, number>;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly radius: Float32Array;
  readonly charge: Float32Array;
  // 1 while a node is held by a drag: it stays where the pointer puts it.
  readonly fixed: Uint8Array;
  readonly source: Int32Array;
  readonly target: Int32Array;
  readonly length: Float32Array;
  readonly strength: Float32Array;
  readonly bias: Float32Array;
  alpha: number;
  alphaTarget: number;
  readonly tree: QuadTree;
};

export function nodeRadius(node: MapNode, biggestHub: number): number {
  switch (node.kind) {
    case "file":
      return 2.5;
    case "more":
      return 3.5;
    case "protocol":
    case "experiment":
    case "person":
    case "instrument":
      // Area follows the file count, against the lab's biggest hub.
      return 4 + 20 * Math.sqrt(node.files / Math.max(biggestHub, 1));
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

function isHub(node: MapNode): boolean {
  return node.kind !== "file" && node.kind !== "more";
}

function restLength(edge: MapEdge, r: (id: MapNodeId) => number): number {
  switch (edge.kind) {
    case "uses":
      return 110;
    case "shared":
      return 150;
    case "similar":
      return 28;
    case "label":
    case "attached":
    case "chart":
    case "talk-through":
    case "more":
      return 18 + Math.max(r(edge.source), r(edge.target));
    default: {
      const _exhaustive: never = edge;
      return _exhaustive;
    }
  }
}

function strengthFactor(edge: MapEdge, heaviest: number): number {
  switch (edge.kind) {
    case "uses":
      return 0.5;
    case "shared":
      return 0.04 + 0.4 * Math.sqrt(edge.weight / Math.max(heaviest, 1));
    case "similar":
      return 0.3;
    case "label":
    case "attached":
    case "chart":
    case "talk-through":
    case "more":
      return 1;
    default: {
      const _exhaustive: never = edge;
      return _exhaustive;
    }
  }
}

// A small seeded generator, so a layout is the same every time for the same graph.
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

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Builds the layout for a graph. Nodes the previous layout had keep their place, so opening a
// hub only moves things a little; new nodes start around the node they link to.
export function createLayout(graph: Graph, previous: Layout | null = null): Layout {
  const nodes = [...graph.nodes.values()];
  const n = nodes.length;
  if (n > MAX_LAYOUT_NODES) throw new Error(`the map lays out at most ${MAX_LAYOUT_NODES} nodes, not ${n}`);
  const ids = nodes.map((node) => node.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const biggest = nodes.reduce((m, node) => (node.kind === "file" || node.kind === "more" ? m : Math.max(m, node.files)), 0);
  const radius = new Float32Array(n);
  const charge = new Float32Array(n);
  nodes.forEach((node, i) => {
    radius[i] = nodeRadius(node, biggest);
    charge[i] = isHub(node) ? -50 - 6 * radius[i] : -16;
  });

  const edges = graph.edges.filter((e) => index.has(e.source) && index.has(e.target));
  const m = edges.length;
  const source = new Int32Array(m);
  const target = new Int32Array(m);
  const length = new Float32Array(m);
  const strength = new Float32Array(m);
  const bias = new Float32Array(m);
  const degree = new Int32Array(n);
  const heaviest = edges.reduce((w, e) => (e.kind === "shared" ? Math.max(w, e.weight) : w), 0);
  const r = (id: MapNodeId) => radius[index.get(id) ?? 0];
  edges.forEach((e, k) => {
    const s = index.get(e.source) ?? 0;
    const t = index.get(e.target) ?? 0;
    source[k] = s;
    target[k] = t;
    degree[s]++;
    degree[t]++;
    length[k] = restLength(e, r);
  });
  edges.forEach((e, k) => {
    const ds = degree[source[k]];
    const dt = degree[target[k]];
    strength[k] = strengthFactor(e, heaviest) / Math.min(ds, dt);
    bias[k] = ds / (ds + dt);
  });

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const placed = new Uint8Array(n);
  let kept = 0;
  if (previous !== null) {
    ids.forEach((id, i) => {
      const j = previous.index.get(id);
      if (j === undefined) return;
      x[i] = previous.x[j];
      y[i] = previous.y[j];
      placed[i] = 1;
      kept++;
    });
  }
  const rand = mulberry32(hashString(ids.slice(0, 64).join("|")) ^ n);
  // New hubs on a sunflower, biggest nearest the middle.
  const newHubs = nodes
    .map((node, i) => ({ node, i }))
    .filter(({ node, i }) => isHub(node) && placed[i] === 0)
    .sort((a, b) => (b.node.kind === "file" || b.node.kind === "more" ? 0 : b.node.files) - (a.node.kind === "file" || a.node.kind === "more" ? 0 : a.node.files));
  const spread = kept > 0 ? 60 : 0;
  newHubs.forEach(({ i }, j) => {
    const rad = spread + 55 * Math.sqrt(j + 0.5);
    x[i] = Math.cos(j * GOLDEN) * rad;
    y[i] = Math.sin(j * GOLDEN) * rad;
    placed[i] = 1;
  });
  // Everything else around its first placed neighbor, in a small sunflower of its own.
  const around = new Int32Array(n);
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 0; k < m; k++) {
      for (const [a, b] of [
        [source[k], target[k]],
        [target[k], source[k]],
      ] as const) {
        if (placed[a] === 0 && placed[b] === 1) {
          const j = around[b];
          around[b] = j + 1;
          const rad = radius[b] + 8 + 5 * Math.sqrt(j + 1);
          const turn = j * GOLDEN + (hashString(ids[b]) % 628) / 100;
          x[a] = x[b] + Math.cos(turn) * rad;
          y[a] = y[b] + Math.sin(turn) * rad;
          placed[a] = 1;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (placed[i] === 1) continue;
    const rad = 80 + 40 * Math.sqrt(i + rand());
    x[i] = Math.cos(i * GOLDEN) * rad;
    y[i] = Math.sin(i * GOLDEN) * rad;
  }
  return {
    ids,
    index,
    x,
    y,
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    radius,
    charge,
    fixed: new Uint8Array(n),
    source,
    target,
    length,
    strength,
    bias,
    // A layout that kept most of its places only needs a nudge.
    alpha: previous !== null && kept * 2 >= n ? 0.35 : 1,
    alphaTarget: 0,
    tree: new QuadTree(),
  };
}

export function isSettled(layout: Layout): boolean {
  return layout.alpha < ALPHA_MIN && layout.alphaTarget === 0;
}

export function tick(layout: Layout): void {
  const { x, y, vx, vy, fixed, source, target, length, strength, bias } = layout;
  const n = layout.ids.length;
  layout.alpha += (layout.alphaTarget - layout.alpha) * ALPHA_DECAY;
  const alpha = layout.alpha;

  for (let k = 0; k < source.length; k++) {
    const s = source[k];
    const t = target[k];
    let dx = x[t] + vx[t] - x[s] - vx[s];
    let dy = y[t] + vy[t] - y[s] - vy[s];
    if (dx === 0 && dy === 0) dx = 1e-3 * ((k % 7) - 3) || 1e-3;
    const l = Math.sqrt(dx * dx + dy * dy);
    const f = ((l - length[k]) / l) * alpha * strength[k];
    dx *= f;
    dy *= f;
    const b = bias[k];
    vx[t] = vx[t] - dx * b;
    vy[t] = vy[t] - dy * b;
    vx[s] = vx[s] + dx * (1 - b);
    vy[s] = vy[s] + dy * (1 - b);
  }

  layout.tree.build(x, y, layout.charge, n);
  layout.tree.repel(x, y, layout.charge, vx, vy, n, alpha);

  for (let i = 0; i < n; i++) {
    if (fixed[i] === 1) {
      vx[i] = 0;
      vy[i] = 0;
      continue;
    }
    const gx = vx[i] - x[i] * GRAVITY * alpha;
    const gy = vy[i] - y[i] * GRAVITY * alpha;
    vx[i] = gx * (1 - VELOCITY_DECAY);
    vy[i] = gy * (1 - VELOCITY_DECAY);
    x[i] = x[i] + vx[i];
    y[i] = y[i] + vy[i];
  }
}

// Ticks until the layout rests or the budget runs out; returns how many ticks it took.
export function settle(layout: Layout, maxTicks: number): number {
  let ticks = 0;
  while (ticks < maxTicks && !isSettled(layout)) {
    tick(layout);
    ticks++;
  }
  return ticks;
}

// Holds a node where a drag puts it; the rest of the map follows while it's held.
export function hold(layout: Layout, i: number, px: number, py: number): void {
  layout.fixed[i] = 1;
  layout.x[i] = px;
  layout.y[i] = py;
  layout.alphaTarget = 0.25;
  if (layout.alpha < 0.25) layout.alpha = 0.25;
}

export function release(layout: Layout, i: number): void {
  layout.fixed[i] = 0;
  layout.alphaTarget = 0;
}

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export function bounds(layout: Layout, only?: ReadonlySet<number>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < layout.ids.length; i++) {
    if (only !== undefined && !only.has(i)) continue;
    const r = layout.radius[i];
    const px = layout.x[i];
    const py = layout.y[i];
    minX = Math.min(minX, px - r);
    minY = Math.min(minY, py - r);
    maxX = Math.max(maxX, px + r);
    maxY = Math.max(maxY, py + r);
  }
  if (minX === Infinity) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}

// The node under a point, within `slop` of its edge; -1 when there's none.
export function nodeAt(layout: Layout, px: number, py: number, slop: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < layout.ids.length; i++) {
    const dx = layout.x[i] - px;
    const dy = layout.y[i] - py;
    const reach = layout.radius[i] + slop;
    const d = dx * dx + dy * dy;
    if (d <= reach * reach && d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

// A Barnes-Hut quadtree in flat arrays, rebuilt every tick. A leaf holds a chain of the points
// in it (several when they sit on one spot or the tree is as deep as it goes).
class QuadTree {
  private cap = 0;
  private count = 0;
  private child = new Int32Array(0);
  private head = new Int32Array(0);
  private size = new Float64Array(0);
  private weight = new Float64Array(0);
  private cx = new Float64Array(0);
  private cy = new Float64Array(0);
  private next = new Int32Array(0);
  private stack = new Int32Array(0);
  private x0 = 0;
  private y0 = 0;
  private width = 0;

  private grow(cells: number): void {
    if (cells <= this.cap) return;
    const cap = Math.max(cells, this.cap * 2, 64);
    const child = new Int32Array(cap * 4).fill(-1);
    child.set(this.child.subarray(0, this.count * 4));
    const resize = (a: Float64Array) => {
      const b = new Float64Array(cap);
      b.set(a.subarray(0, this.count));
      return b;
    };
    const head = new Int32Array(cap).fill(-1);
    head.set(this.head.subarray(0, this.count));
    this.child = child;
    this.head = head;
    this.size = resize(this.size);
    this.weight = resize(this.weight);
    this.cx = resize(this.cx);
    this.cy = resize(this.cy);
    this.cap = cap;
  }

  private cell(size: number): number {
    this.grow(this.count + 1);
    const c = this.count++;
    this.child.fill(-1, c * 4, c * 4 + 4);
    this.head[c] = -1;
    this.size[c] = size;
    return c;
  }

  build(x: Float64Array, y: Float64Array, charge: Float32Array, n: number): void {
    if (this.next.length < n) {
      this.next = new Int32Array(n);
      this.stack = new Int32Array(Math.max(256, n * 4));
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, x[i]);
      minY = Math.min(minY, y[i]);
      maxX = Math.max(maxX, x[i]);
      maxY = Math.max(maxY, y[i]);
    }
    this.count = 0;
    this.x0 = minX;
    this.y0 = minY;
    this.width = Math.max(maxX - minX, maxY - minY, 1) * 1.0001;
    if (n === 0) return;
    this.cell(this.width);
    // A leaf is head >= 0 (its chain) or -1 (empty); -2 marks a split cell.
    for (let i = 0; i < n; i++) this.insert(i, x, y);
    for (let c = this.count - 1; c >= 0; c--) {
      let w = 0;
      let sx = 0;
      let sy = 0;
      const h = this.head[c];
      if (h >= 0) {
        for (let p = h; p >= 0; p = this.next[p]) {
          const q = charge[p];
          w += q;
          sx += q * x[p];
          sy += q * y[p];
        }
      } else {
        for (let k = 0; k < 4; k++) {
          const ch = this.child[c * 4 + k];
          if (ch < 0) continue;
          const q = this.weight[ch];
          w += q;
          sx += q * this.cx[ch];
          sy += q * this.cy[ch];
        }
      }
      this.weight[c] = w;
      this.cx[c] = w === 0 ? 0 : sx / w;
      this.cy[c] = w === 0 ? 0 : sy / w;
    }
  }

  private insert(i: number, x: Float64Array, y: Float64Array): void {
    let c = 0;
    let cx0 = this.x0;
    let cy0 = this.y0;
    let size = this.width;
    const px = x[i];
    const py = y[i];
    for (let depth = 0; ; depth++) {
      const h = this.head[c];
      if (h === -1) {
        this.head[c] = i;
        this.next[i] = -1;
        return;
      }
      if (h >= 0) {
        const same = x[h] === px && y[h] === py;
        if (same || depth >= 24) {
          this.next[i] = h;
          this.head[c] = i;
          return;
        }
        // Split: the chain moves down one level, then this point carries on.
        this.head[c] = -2;
        const half = size / 2;
        const qx = x[h] >= cx0 + half ? 1 : 0;
        const qy = y[h] >= cy0 + half ? 1 : 0;
        const down = this.cell(half);
        this.child[c * 4 + qy * 2 + qx] = down;
        this.head[down] = h;
      }
      const half = size / 2;
      const qx = px >= cx0 + half ? 1 : 0;
      const qy = py >= cy0 + half ? 1 : 0;
      let down = this.child[c * 4 + qy * 2 + qx];
      if (down < 0) {
        down = this.cell(half);
        this.child[c * 4 + qy * 2 + qx] = down;
      }
      cx0 += qx * half;
      cy0 += qy * half;
      size = half;
      c = down;
    }
  }

  repel(x: Float64Array, y: Float64Array, charge: Float32Array, vx: Float64Array, vy: Float64Array, n: number, alpha: number): void {
    if (this.count === 0) return;
    const stack = this.stack;
    for (let i = 0; i < n; i++) {
      const px = x[i];
      const py = y[i];
      let fx = 0;
      let fy = 0;
      let top = 0;
      stack[top++] = 0;
      while (top > 0) {
        const c = stack[--top];
        const h = this.head[c];
        if (h >= 0) {
          for (let p = h; p >= 0; p = this.next[p]) {
            if (p === i) continue;
            let dx = x[p] - px;
            let dy = y[p] - py;
            if (dx === 0 && dy === 0) {
              // Two nodes on one spot: a fixed, tiny shove apart.
              dx = (((p - i) % 5) + 0.5) * 1e-3;
              dy = (((i * 7 + p) % 3) - 1) * 1e-3;
            }
            const f = (charge[p] * alpha) / Math.max(dx * dx + dy * dy, 1);
            fx += dx * f;
            fy += dy * f;
          }
          continue;
        }
        const w = this.weight[c];
        if (w === 0) continue;
        const dx = this.cx[c] - px;
        const dy = this.cy[c] - py;
        const d2 = dx * dx + dy * dy;
        const s = this.size[c];
        if (s * s < THETA2 * d2) {
          const f = (w * alpha) / Math.max(d2, 1);
          fx += dx * f;
          fy += dy * f;
          continue;
        }
        for (let k = 0; k < 4; k++) {
          const ch = this.child[c * 4 + k];
          if (ch >= 0) stack[top++] = ch;
        }
      }
      vx[i] = vx[i] + fx;
      vy[i] = vy[i] + fy;
    }
  }
}
