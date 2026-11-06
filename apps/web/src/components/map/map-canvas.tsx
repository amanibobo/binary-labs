"use client";

import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import type { Graph, MapNode, MapNodeId } from "@/lib/map";
import { bounds, createLayout, hold, isSettled, nodeAt, release, tick, type Layout } from "@/lib/map-layout";

// The lab map drawn on a canvas (decisions.md, "the lab map": SVG dropped to 12 frames a
// second at 20,000 moving nodes, canvas held 60). Thin lines, small dots, names that appear as
// you zoom in. Pan by dragging the background, zoom with the wheel or a pinch, drag a dot to
// move it; hovering or focusing a dot lights it and its neighbors and dims the rest.

type Props = {
  graph: Graph;
  // The dot to light (hovered, focused or picked in search), or null.
  active: MapNodeId | null;
  onActiveChange: (id: MapNodeId | null) => void;
  // A click or Enter on a dot.
  onActivate: (node: MapNode) => void;
  // Moves the camera to this dot when it changes.
  centerOn: MapNodeId | null;
  label: string;
  describedBy: string;
  className?: string;
};

type Colors = { kind: Record<MapNode["kind"], string>; edge: string; strong: string; text: string; muted: string; surface: string; ring: string; font: string };

const KIND_ORDER = ["protocol", "experiment", "person", "instrument", "file", "more"] as const;

function readColors(el: HTMLElement): Colors {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    kind: {
      protocol: v("--map-protocol"),
      experiment: v("--map-experiment"),
      person: v("--map-person"),
      instrument: v("--map-instrument"),
      file: v("--map-file"),
      more: v("--map-file"),
    },
    edge: v("--map-edge"),
    strong: v("--map-edge-strong"),
    text: v("--content-primary"),
    muted: v("--content-tertiary"),
    surface: v("--background-primary"),
    ring: v("--border-accent") || v("--content-accent"),
    font: getComputedStyle(document.body).fontFamily,
  };
}

type Camera = { x: number; y: number; k: number };
type Gesture =
  | { kind: "none" }
  | { kind: "pan"; id: number; sx: number; sy: number; cam: Camera; moved: boolean }
  | { kind: "node"; id: number; sx: number; sy: number; node: number; moved: boolean; touch: boolean }
  | { kind: "pinch"; d0: number; k0: number; cx: number; cy: number; cam: Camera };

type CanvasState = {
  cam: Camera;
  size: { w: number; h: number; dpr: number };
  // Read from the page's CSS on the first frame and again after a theme change.
  colors: Colors | null;
  hover: number;
  active: number;
  gesture: Gesture;
  pointers: Map<number, { x: number; y: number }>;
  // Keeps fitting the map to the screen until someone pans or zooms.
  autoFit: boolean;
  raf: number;
  reduced: boolean;
  zoomedAt: number;
};

const MIN_K = 0.04;
const MAX_K = 8;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

export function MapCanvas({ graph, active, onActiveChange, onActivate, centerOn, label, describedBy, className }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const previous = useRef<Layout | null>(null);
  const layout = useMemo(() => {
    const next = createLayout(graph, previous.current);
    return next;
  }, [graph]);
  const nodes = useMemo(() => layout.ids.map((id) => graph.nodes.get(id)), [layout, graph]);
  const neighbors = useMemo(() => {
    const out: number[][] = layout.ids.map(() => []);
    for (let k = 0; k < layout.source.length; k++) {
      out[layout.source[k]]?.push(layout.target[k]);
      out[layout.target[k]]?.push(layout.source[k]);
    }
    return out;
  }, [layout]);
  const edgeKinds = useMemo(() => graph.edges.map((e) => e.kind), [graph]);

  // Everything the draw loop reads lives in one ref, so a frame never waits on React.
  const state = useRef<CanvasState>({
    cam: { x: 0, y: 0, k: 1 },
    size: { w: 0, h: 0, dpr: 1 },
    colors: null,
    hover: -1,
    active: -1,
    gesture: { kind: "none" },
    pointers: new Map<number, { x: number; y: number }>(),
    autoFit: true,
    raf: 0,
    reduced: false,
    zoomedAt: 0,
  });
  const latest = useRef({ graph, layout, nodes, neighbors, edgeKinds, onActiveChange, onActivate });
  useEffect(() => {
    latest.current = { graph, layout, nodes, neighbors, edgeKinds, onActiveChange, onActivate };
  });

  useEffect(() => {
    const s = state.current;
    s.active = active === null ? -1 : (layout.index.get(active) ?? -1);
    schedule();
  });

  function schedule() {
    const s = state.current;
    if (s.raf === 0) s.raf = requestAnimationFrame(frame);
  }

  function fit(only?: ReadonlySet<number>) {
    const s = state.current;
    const L = latest.current.layout;
    const b = bounds(L, only);
    const pad = 48;
    const w = Math.max(b.maxX - b.minX, 1);
    const h = Math.max(b.maxY - b.minY, 1);
    const k = clampK(Math.min((s.size.w - pad * 2) / w, (s.size.h - pad * 2) / h, 2));
    s.cam = { k, x: s.size.w / 2 - ((b.minX + b.maxX) / 2) * k, y: s.size.h / 2 - ((b.minY + b.maxY) / 2) * k };
  }

  function frame() {
    const s = state.current;
    s.raf = 0;
    const L = latest.current.layout;
    // While someone pans or zooms a big map, the layout waits, so the camera keeps up.
    const moving = s.gesture.kind === "pan" || s.gesture.kind === "pinch" || performance.now() - s.zoomedAt < 150;
    if (!isSettled(L) && moving && L.ids.length > 2000) schedule();
    else if (!isSettled(L)) {
      const start = performance.now();
      // Small maps settle in a couple of seconds; big ones take what a frame allows.
      do tick(L);
      while (!isSettled(L) && performance.now() - start < 6 && L.ids.length < 2000);
      if (s.autoFit) fit();
      schedule();
    }
    draw();
  }

  function draw() {
    const s = state.current;
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    s.colors ??= readColors(el);
    const c = s.colors;
    const { layout: L, nodes: ns, neighbors: nb, edgeKinds: ek, graph } = latest.current;
    const { w, h, dpr } = s.size;
    const { k, x: tx, y: ty } = s.cam;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const lit = s.hover >= 0 ? s.hover : s.active;
    const near = new Set<number>(lit >= 0 ? [lit, ...(nb[lit] ?? [])] : []);
    const dim = lit >= 0;

    // Edges, thin and the same width at every zoom.
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    ctx.lineWidth = 1 / k;
    const strokeEdges = (pick: (e: number) => boolean, color: string, alpha: number, dash: boolean) => {
      ctx.beginPath();
      for (let e = 0; e < L.source.length; e++) {
        if (!pick(e)) continue;
        const a = L.source[e];
        const b = L.target[e];
        ctx.moveTo(L.x[a], L.y[a]);
        ctx.lineTo(L.x[b], L.y[b]);
      }
      ctx.setLineDash(dash ? [3 / k, 3 / k] : []);
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.stroke();
    };
    const touchesLit = (e: number) => L.source[e] === lit || L.target[e] === lit;
    // Files two hubs share are the faintest lines: they say who works with whom, not a link
    // anyone made.
    strokeEdges((e) => !touchesLit(e) && ek[e] === "shared", c.edge, dim ? 0.2 : 0.6, false);
    strokeEdges((e) => !touchesLit(e) && ek[e] !== "similar" && ek[e] !== "shared", c.edge, dim ? 0.35 : 1, false);
    strokeEdges((e) => !touchesLit(e) && ek[e] === "similar", c.edge, dim ? 0.35 : 1, true);
    if (lit >= 0) strokeEdges(touchesLit, c.strong, 0.9, false);
    ctx.setLineDash([]);

    // Dots, one path per kind. On screen a dot is never under a point and a half, nor over 14
    // points however far in, so a local map's few hubs stay dots rather than discs.
    const minR = 1.5 / k;
    const drawR = (i: number) => Math.min(Math.max(L.radius[i], minR), 14 / k);
    for (const kind of KIND_ORDER) {
      for (const pass of dim ? [false, true] : [true]) {
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < ns.length; i++) {
          const node = ns[i];
          if (node?.kind !== kind) continue;
          if (dim && near.has(i) !== pass) continue;
          const r = drawR(i);
          ctx.moveTo(L.x[i] + r, L.y[i]);
          ctx.arc(L.x[i], L.y[i], r, 0, Math.PI * 2);
          any = true;
        }
        if (!any) continue;
        ctx.globalAlpha = dim && !pass ? 0.18 : 1;
        // Instruments and the "more" dot are rings, so ink alone still tells them apart.
        if (kind === "instrument" || kind === "more") {
          ctx.lineWidth = (kind === "instrument" ? 2 : 1.25) / k;
          ctx.strokeStyle = c.kind[kind];
          ctx.fillStyle = c.surface;
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillStyle = c.kind[kind];
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;

    // A local map's center keeps a ring in ink; the lit dot gets one in the focus color.
    const center = graph.center === null ? -1 : (L.index.get(graph.center) ?? -1);
    if (center >= 0 && center !== lit) {
      ctx.beginPath();
      ctx.arc(L.x[center], L.y[center], drawR(center) + 3 / k, 0, Math.PI * 2);
      ctx.lineWidth = 1.25 / k;
      ctx.strokeStyle = c.text;
      ctx.stroke();
    }
    if (lit >= 0) {
      ctx.beginPath();
      ctx.arc(L.x[lit], L.y[lit], drawR(lit) + 3 / k, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 / k;
      ctx.strokeStyle = c.ring;
      ctx.stroke();
    }

    // Names: the lit dot and its neighbors, hubs once they're big enough on screen, files once
    // you've zoomed in. Nothing is written over a name already placed.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `500 11px ${c.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const fileAlpha = Math.min(1, Math.max(0, (k - 1.3) / 0.6));
    const order: { i: number; p: number }[] = [];
    for (let i = 0; i < ns.length; i++) {
      const node = ns[i];
      if (node === undefined) continue;
      const sx = L.x[i] * k + tx;
      const sy = L.y[i] * k + ty;
      if (sx < -80 || sx > w + 80 || sy < -20 || sy > h + 20) continue;
      const hub = node.kind !== "file" && node.kind !== "more";
      const screenR = L.radius[i] * k;
      if (i === lit || i === center) order.push({ i, p: 0 });
      else if (near.has(i)) order.push({ i, p: 1 });
      else if (hub && (screenR >= 5 || k >= 0.6)) order.push({ i, p: 2 + 1 / (1 + screenR) });
      else if (node.kind === "more") order.push({ i, p: 3 });
      else if (!hub && fileAlpha > 0) order.push({ i, p: 4 });
    }
    order.sort((a, b) => a.p - b.p);
    const taken: [number, number, number, number][] = [];
    // At most 150 names: past that a screen is all text, and placing them costs the frame.
    for (const { i, p } of order.slice(0, 150)) {
      const node = ns[i];
      if (node === undefined) continue;
      const text = node.kind === "more" ? `${node.hidden.toLocaleString("en-US")} more` : node.name;
      const shown = text.length > 34 ? `${text.slice(0, 32)}…` : text;
      const tw = ctx.measureText(shown).width;
      const sx = L.x[i] * k + tx;
      const sy = L.y[i] * k + ty + drawR(i) * k + 3;
      const box: [number, number, number, number] = [sx - tw / 2 - 2, sy - 1, sx + tw / 2 + 2, sy + 13];
      if (p > 1 && taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) continue;
      taken.push(box);
      const hub = node.kind !== "file" && node.kind !== "more";
      ctx.globalAlpha = p <= 1 ? 1 : dim ? 0.25 : hub || node.kind === "more" ? 1 : fileAlpha;
      // A halo in the surface color keeps a name readable over lines.
      ctx.lineWidth = 3;
      ctx.strokeStyle = c.surface;
      ctx.strokeText(shown, sx, sy);
      ctx.fillStyle = hub || p <= 1 ? c.text : c.muted;
      ctx.fillText(shown, sx, sy);
    }
    ctx.globalAlpha = 1;
  }

  // A new graph keeps the old places; the first one fits itself to the screen as it settles.
  useEffect(() => {
    previous.current = layout;
    const s = state.current;
    if (s.reduced) {
      const start = performance.now();
      while (!isSettled(layout) && performance.now() - start < 1500) tick(layout);
      if (s.autoFit) fit();
    }
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per layout
  }, [layout]);

  useEffect(() => {
    if (centerOn === null) return;
    const s = state.current;
    const i = layout.index.get(centerOn);
    if (i === undefined) return;
    s.autoFit = false;
    const k = Math.max(s.cam.k, 0.9);
    s.cam = { k, x: s.size.w / 2 - layout.x[i] * k, y: s.size.h / 2 - layout.y[i] * k };
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when asked to center
  }, [centerOn]);

  useEffect(() => {
    const el = canvas.current;
    const box = wrap.current;
    if (!el || !box) return;
    const s = state.current;
    s.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = box.clientWidth;
      const h = box.clientHeight;
      s.size = { w, h, dpr };
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      if (s.autoFit) fit();
      schedule();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    // The theme toggle and the device's own setting both repaint the map in the new colors.
    const recolor = () => {
      s.colors = null;
      schedule();
    };
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", recolor);
    // React's wheel listener is passive, and the map needs to stop the page scrolling.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", recolor);
      el.removeEventListener("wheel", wheel);
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- set up once
  }, []);

  function zoomAt(px: number, py: number, factor: number) {
    const s = state.current;
    const k = clampK(s.cam.k * factor);
    const f = k / s.cam.k;
    s.autoFit = false;
    s.zoomedAt = performance.now();
    s.cam = { k, x: px - (px - s.cam.x) * f, y: py - (py - s.cam.y) * f };
    schedule();
  }

  const toWorld = (px: number, py: number) => {
    const { cam } = state.current;
    return { x: (px - cam.x) / cam.k, y: (py - cam.y) / cam.k };
  };

  function local(e: { clientX: number; clientY: number }) {
    const r = canvas.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }

  function hit(px: number, py: number): number {
    const { cam } = state.current;
    const p = toWorld(px, py);
    return nodeAt(latest.current.layout, p.x, p.y, 6 / cam.k);
  }

  function setHover(i: number) {
    const s = state.current;
    if (s.hover === i) return;
    s.hover = i;
    const el = canvas.current;
    if (el) el.style.cursor = i >= 0 ? "pointer" : "grab";
    latest.current.onActiveChange(i >= 0 ? latest.current.layout.ids[i] ?? null : null);
    schedule();
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const s = state.current;
    const p = local(e);
    s.pointers.set(e.pointerId, p);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (s.pointers.size === 2) {
      const [a, b] = [...s.pointers.values()];
      if (a && b) {
        s.gesture = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), k0: s.cam.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, cam: s.cam };
      }
      return;
    }
    const i = hit(p.x, p.y);
    s.gesture =
      i >= 0
        ? { kind: "node", id: e.pointerId, sx: p.x, sy: p.y, node: i, moved: false, touch: e.pointerType !== "mouse" }
        : { kind: "pan", id: e.pointerId, sx: p.x, sy: p.y, cam: s.cam, moved: false };
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const s = state.current;
    const p = local(e);
    if (s.pointers.has(e.pointerId)) s.pointers.set(e.pointerId, p);
    const g = s.gesture;
    switch (g.kind) {
      case "none":
        if (e.pointerType === "mouse") setHover(hit(p.x, p.y));
        return;
      case "pinch": {
        const [a, b] = [...s.pointers.values()];
        if (!a || !b) return;
        const k = clampK((g.k0 * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(g.d0, 1));
        const f = k / g.cam.k;
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        s.autoFit = false;
        s.cam = { k, x: cx - (g.cx - g.cam.x) * f, y: cy - (g.cy - g.cam.y) * f };
        schedule();
        return;
      }
      case "pan": {
        if (Math.hypot(p.x - g.sx, p.y - g.sy) > 4) g.moved = true;
        if (!g.moved) return;
        s.autoFit = false;
        s.cam = { ...g.cam, x: g.cam.x + p.x - g.sx, y: g.cam.y + p.y - g.sy };
        schedule();
        return;
      }
      case "node": {
        if (Math.hypot(p.x - g.sx, p.y - g.sy) > 4) g.moved = true;
        if (!g.moved) return;
        s.autoFit = false;
        const w = toWorld(p.x, p.y);
        hold(latest.current.layout, g.node, w.x, w.y);
        schedule();
        return;
      }
      default: {
        const _exhaustive: never = g;
        return _exhaustive;
      }
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const s = state.current;
    s.pointers.delete(e.pointerId);
    const g = s.gesture;
    s.gesture = { kind: "none" };
    if (g.kind === "node") {
      if (g.moved) {
        release(latest.current.layout, g.node);
        schedule();
        return;
      }
      const node = latest.current.nodes[g.node];
      if (node === undefined) return;
      // On a touch screen the first tap shows what a dot is; a second one opens it.
      if (g.touch && s.active !== g.node) {
        latest.current.onActiveChange(node.id);
        return;
      }
      latest.current.onActivate(node);
    } else if (g.kind === "pan" && !g.moved) {
      latest.current.onActiveChange(null);
    }
  }

  // Arrow keys step to the nearest dot in that direction; Enter opens it.
  function onKeyDown(e: ReactKeyboardEvent<HTMLCanvasElement>) {
    const s = state.current;
    const L = latest.current.layout;
    const dirs: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    const dir = dirs[e.key];
    if (dir !== undefined) {
      e.preventDefault();
      const from = s.active;
      const ox = from >= 0 ? L.x[from] : (s.size.w / 2 - s.cam.x) / s.cam.k;
      const oy = from >= 0 ? L.y[from] : (s.size.h / 2 - s.cam.y) / s.cam.k;
      let best = -1;
      let bestScore = Infinity;
      for (let i = 0; i < L.ids.length; i++) {
        if (i === from) continue;
        const dx = L.x[i] - ox;
        const dy = L.y[i] - oy;
        const along = dx * dir[0] + dy * dir[1];
        if (from >= 0 && along <= 0) continue;
        const across = Math.abs(dx * dir[1] - dy * dir[0]);
        const score = Math.max(along, 0) + across * 2 + (from < 0 ? Math.hypot(dx, dy) : 0);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best >= 0) {
        latest.current.onActiveChange(L.ids[best] ?? null);
        const sx = L.x[best] * s.cam.k + s.cam.x;
        const sy = L.y[best] * s.cam.k + s.cam.y;
        if (sx < 40 || sx > s.size.w - 40 || sy < 40 || sy > s.size.h - 40) {
          s.autoFit = false;
          s.cam = { ...s.cam, x: s.size.w / 2 - L.x[best] * s.cam.k, y: s.size.h / 2 - L.y[best] * s.cam.k };
        }
        schedule();
      }
      return;
    }
    if (e.key === "Enter" && s.active >= 0) {
      const node = latest.current.nodes[s.active];
      if (node !== undefined) latest.current.onActivate(node);
    } else if (e.key === "+" || e.key === "=") {
      zoomAt(s.size.w / 2, s.size.h / 2, 1.25);
    } else if (e.key === "-") {
      zoomAt(s.size.w / 2, s.size.h / 2, 0.8);
    } else if (e.key === "0") {
      s.autoFit = true;
      fit();
      schedule();
    } else if (e.key === "Escape") {
      latest.current.onActiveChange(null);
    }
  }

  return (
    <div ref={wrap} className={cn("relative min-h-0 overflow-hidden", className)}>
      <canvas
        ref={canvas}
        tabIndex={0}
        role="application"
        aria-roledescription="map"
        aria-label={label}
        aria-describedby={describedBy}
        className="block touch-none cursor-grab rounded-none outline-none focus-visible:ring-2 focus-visible:ring-border-accent focus-visible:ring-inset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse" && state.current.gesture.kind === "none") setHover(-1);
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
