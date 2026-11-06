// A vector PDF of a chart's exported SVG (decisions.md, "charts round 1"). The SVG is our own
// markup (chart-svg.tsx, summary-svg.tsx) in export ink, so this reads only what they write:
// g, rect, line, path (M L H V Q C Z), circle, text and tspan, a rect clip and a linear
// gradient, with inherited fill, stroke, width, dashes, opacity and font size. Text is set in
// Helvetica, one of the fonts every PDF reader has, so nothing is embedded. The builder loads
// this file only when someone asks for a PDF.

type Node = { tag: string; attrs: Record<string, string>; children: Node[]; text: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m)));

// The markup as a tree: tags, attributes and text, nothing else.
export function parseSvg(markup: string): Node {
  const root: Node = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: Node[] = [root];
  const re = /<\?[^>]*\?>|<!--[\s\S]*?-->|<\/([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(markup); m !== null; m = re.exec(markup)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[2] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of m[3].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescape(a[2] ?? a[3] ?? "");
      const node: Node = { tag: m[2], attrs, children: [], text: "" };
      top.children.push(node);
      if (m[4] !== "/") stack.push(node);
    } else if (m[5] !== undefined) {
      top.text += unescape(m[5]);
      top.children.push({ tag: "#text", attrs: {}, children: [], text: unescape(m[5]) });
    }
  }
  return root.children.find((c) => c.tag === "svg") ?? root;
}

// Helvetica's widths (thousandths of an em) for WinAnsi 32 to 126, from its AFM.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778,
  722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778,
  722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
// WinAnsi bytes past 127 that charts print, with their Helvetica widths.
const EXTRA: Record<string, [number, number]> = {
  "µ": [0xb5, 556],
  "²": [0xb2, 333],
  "³": [0xb3, 333],
  "±": [0xb1, 584],
  "×": [0xd7, 584],
  "÷": [0xf7, 584],
  "°": [0xb0, 400],
  "–": [0x96, 556],
  "—": [0x97, 1000],
  "…": [0x85, 1000],
  "’": [0x92, 222],
  "‘": [0x91, 222],
  "“": [0x93, 333],
  "”": [0x94, 333],
  "·": [0xb7, 278],
  "é": [0xe9, 556],
  "ö": [0xf6, 556],
  "ü": [0xfc, 556],
  "\u00a0": [0xa0, 278],
};
// Characters WinAnsi doesn't have, written the way a typewriter would.
const SPELLED: Record<string, string> = { "−": "-", "∛": "cbrt ", "√": "sqrt ", "₂": "2", "Δ": "D", "≤": "<=", "≥": ">=", "→": "->", "⁻": "-", "¹": "1", "\u202f": " ", "\u2009": " " };

function encode(text: string): number[] {
  const out: number[] = [];
  for (const ch of [...text].flatMap((c) => [...(SPELLED[c] ?? c)])) {
    const code = ch.codePointAt(0) ?? 63;
    if (code >= 32 && code <= 126) out.push(code);
    else out.push(EXTRA[ch]?.[0] ?? 63);
  }
  return out;
}

export function textWidthPt(text: string, size: number, bold: boolean): number {
  const table = bold ? BOLD : HELVETICA;
  let w = 0;
  for (const b of encode(text)) {
    if (b >= 32 && b <= 126) w += table[b - 32];
    else w += Object.values(EXTRA).find(([code]) => code === b)?.[1] ?? 556;
  }
  return (w / 1000) * size;
}

type Style = { fill: string | null; stroke: string | null; strokeWidth: number; dash: string | null; fillOpacity: number; fontSize: number; bold: boolean; anchor: string; baseline: string; cap: string; join: string };

const num = (v: string | undefined, fallback = 0) => {
  const n = v === undefined ? Number.NaN : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};
const f = (n: number) => (Math.abs(n) < 1e-9 ? "0" : Number(n.toFixed(3)).toString());

function rgb(color: string | null): [number, number, number] | null {
  if (color === null || color === "none" || color === "transparent") return null;
  let m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (m !== null) return [0, 2, 4].map((i) => parseInt(m?.[1].slice(i, i + 2) ?? "0", 16) / 255) as [number, number, number];
  m = /^#([0-9a-f]{3})$/i.exec(color.trim());
  if (m !== null) return [0, 1, 2].map((i) => parseInt((m?.[1][i] ?? "0").repeat(2), 16) / 255) as [number, number, number];
  const r = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (r !== null) return r[1].split(",").slice(0, 3).map((v) => parseFloat(v) / 255) as [number, number, number];
  if (color === "white") return [1, 1, 1];
  if (color === "black") return [0, 0, 0];
  return null;
}

function inherit(parent: Style, a: Record<string, string>): Style {
  const style: Record<string, string> = {};
  for (const part of (a.style ?? "").split(";")) {
    const [k, v] = part.split(":").map((s) => s?.trim());
    if (k && v) style[k] = v;
  }
  const get = (k: string) => a[k] ?? style[k];
  return {
    fill: get("fill") ?? parent.fill,
    stroke: get("stroke") ?? parent.stroke,
    strokeWidth: get("stroke-width") === undefined ? parent.strokeWidth : num(get("stroke-width"), 1),
    dash: get("stroke-dasharray") ?? parent.dash,
    fillOpacity: get("fill-opacity") === undefined ? 1 : num(get("fill-opacity"), 1),
    fontSize: get("font-size") === undefined ? parent.fontSize : num(get("font-size"), parent.fontSize),
    bold: get("font-weight") === undefined ? parent.bold : num(get("font-weight"), 400) >= 600,
    anchor: get("text-anchor") ?? parent.anchor,
    baseline: get("dominant-baseline") ?? parent.baseline,
    cap: get("stroke-linecap") ?? parent.cap,
    join: get("stroke-linejoin") ?? parent.join,
  };
}

// A path's d as PDF operators, with quadratics raised to cubics.
function pathOps(d: string): string {
  const tokens = d.match(/[MLHVQCZmlhvqcz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: string[] = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const next = () => parseFloat(tokens[i++] ?? "0");
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    switch (cmd) {
      case "M":
        x = next();
        y = next();
        sx = x;
        sy = y;
        out.push(`${f(x)} ${f(y)} m`);
        cmd = "L";
        break;
      case "L":
        x = next();
        y = next();
        out.push(`${f(x)} ${f(y)} l`);
        break;
      case "H":
        x = next();
        out.push(`${f(x)} ${f(y)} l`);
        break;
      case "V":
        y = next();
        out.push(`${f(x)} ${f(y)} l`);
        break;
      case "Q": {
        const [qx, qy, ex, ey] = [next(), next(), next(), next()];
        out.push(`${f(x + (2 / 3) * (qx - x))} ${f(y + (2 / 3) * (qy - y))} ${f(ex + (2 / 3) * (qx - ex))} ${f(ey + (2 / 3) * (qy - ey))} ${f(ex)} ${f(ey)} c`);
        x = ex;
        y = ey;
        break;
      }
      case "C": {
        const v = [next(), next(), next(), next(), next(), next()];
        out.push(`${v.map(f).join(" ")} c`);
        x = v[4];
        y = v[5];
        break;
      }
      case "Z":
      case "z":
        out.push("h");
        x = sx;
        y = sy;
        break;
      default:
        i++;
    }
  }
  return out.join("\n");
}

function circleOps(cx: number, cy: number, r: number): string {
  const k = 0.5523 * r;
  return [
    `${f(cx + r)} ${f(cy)} m`,
    `${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c`,
    `${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c`,
    `${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c`,
    `${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c`,
    "h",
  ].join("\n");
}

type Context = { ops: string[]; opacities: Map<number, string>; clips: Map<string, Node>; gradients: Map<string, { offset: number; color: string }[]> };

function paint(ctx: Context, s: Style, shape: string, closed: boolean): void {
  const fill = closed ? rgb(s.fill === null ? "black" : s.fill) : null;
  const stroke = rgb(s.stroke) !== null && s.strokeWidth > 0 ? rgb(s.stroke) : null;
  if (fill === null && stroke === null) return;
  ctx.ops.push("q");
  if (fill !== null && s.fillOpacity < 1) {
    const key = Math.round(s.fillOpacity * 1000) / 1000;
    if (!ctx.opacities.has(key)) ctx.opacities.set(key, `GS${ctx.opacities.size + 1}`);
    ctx.ops.push(`/${ctx.opacities.get(key)} gs`);
  }
  if (fill !== null) ctx.ops.push(`${fill.map(f).join(" ")} rg`);
  if (stroke !== null) {
    ctx.ops.push(`${stroke.map(f).join(" ")} RG`, `${f(s.strokeWidth)} w`);
    ctx.ops.push(`${s.cap === "round" ? 1 : 0} J`, `${s.join === "round" ? 1 : 0} j`);
    if (s.dash !== null && s.dash !== "none") ctx.ops.push(`[${s.dash.split(/[\s,]+/).filter(Boolean).map((v) => f(num(v))).join(" ")}] 0 d`);
  }
  ctx.ops.push(shape, fill !== null && stroke !== null ? "B" : fill !== null ? "f" : "S", "Q");
}

function pdfString(text: string): string {
  return `(${encode(text)
    .map((b) => (b === 40 || b === 41 || b === 92 ? `\\${String.fromCharCode(b)}` : b < 32 || b > 126 ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b)))
    .join("")})`;
}

function drawText(ctx: Context, s: Style, text: string, x: number, y: number, rotate: number): void {
  const fill = rgb(s.fill === null ? "black" : s.fill);
  if (fill === null || text.trim() === "") return;
  const width = textWidthPt(text, s.fontSize, s.bold);
  const shift = s.anchor === "middle" ? -width / 2 : s.anchor === "end" ? -width : 0;
  const drop = s.baseline === "middle" || s.baseline === "central" ? s.fontSize * 0.35 : 0;
  const t = (rotate * Math.PI) / 180;
  const [c, sn] = [Math.cos(t), Math.sin(t)];
  // The glyph's x along the rotation, its up against the page's down (y runs down in SVG).
  const ox = x + c * shift - sn * drop;
  const oy = y + sn * shift + c * drop;
  ctx.ops.push(`BT /${s.bold ? "F2" : "F1"} ${f(s.fontSize)} Tf ${fill.map(f).join(" ")} rg ${f(c)} ${f(sn)} ${f(sn)} ${f(-c)} ${f(ox)} ${f(oy)} Tm ${pdfString(text)} Tj ET`);
}

function walk(ctx: Context, node: Node, parent: Style): void {
  const a = node.attrs;
  const s = inherit(parent, a);
  const clip = /url\(#([^)]+)\)/.exec(a["clip-path"] ?? "")?.[1];
  const clipRect = clip === undefined ? undefined : ctx.clips.get(clip);
  if (clipRect !== undefined) ctx.ops.push("q", `${f(num(clipRect.attrs.x))} ${f(num(clipRect.attrs.y))} ${f(num(clipRect.attrs.width))} ${f(num(clipRect.attrs.height))} re W n`);
  switch (node.tag) {
    case "defs":
    case "clipPath":
    case "linearGradient":
      break;
    case "rect": {
      const [x, y, w, h] = [num(a.x), num(a.y), num(a.width), num(a.height)];
      const gradient = /url\(#([^)]+)\)/.exec(s.fill ?? "")?.[1];
      const stops = gradient === undefined ? undefined : ctx.gradients.get(gradient);
      if (stops !== undefined && stops.length > 1) {
        const strips = 48;
        for (let k = 0; k < strips; k++) {
          const t = (k + 0.5) / strips;
          const j = Math.max(0, stops.findIndex((st) => st.offset >= t) - 1);
          const [s0, s1] = [stops[j], stops[Math.min(stops.length - 1, j + 1)]];
          const u = s1.offset === s0.offset ? 0 : (t - s0.offset) / (s1.offset - s0.offset);
          const c0 = rgb(s0.color) ?? [0, 0, 0];
          const c1 = rgb(s1.color) ?? [0, 0, 0];
          const mix = c0.map((v, i) => v + (c1[i] - v) * u);
          ctx.ops.push(`q ${mix.map(f).join(" ")} rg ${f(x + (w * k) / strips)} ${f(y)} ${f(w / strips + 0.3)} ${f(h)} re f Q`);
        }
        break;
      }
      paint(ctx, s, `${f(x)} ${f(y)} ${f(w)} ${f(h)} re`, true);
      break;
    }
    case "line":
      paint(ctx, { ...s, fill: null }, `${f(num(a.x1))} ${f(num(a.y1))} m ${f(num(a.x2))} ${f(num(a.y2))} l`, false);
      break;
    case "path": {
      const d = a.d ?? "";
      paint(ctx, s, pathOps(d), s.fill !== "none");
      break;
    }
    case "circle":
      paint(ctx, s, circleOps(num(a.cx), num(a.cy), num(a.r)), s.fill !== "none");
      break;
    case "text": {
      const rot = /rotate\(\s*(-?[\d.]+)/.exec(a.transform ?? "");
      const rotate = rot === null ? 0 : parseFloat(rot[1]);
      const spans = node.children.filter((c) => c.tag === "tspan");
      if (spans.length === 0) drawText(ctx, s, node.text, num(a.x), num(a.y), rotate);
      let y = num(a.y);
      for (const span of spans) {
        y += num(span.attrs.dy);
        drawText(ctx, inherit(s, span.attrs), span.text, num(span.attrs.x, num(a.x)), y, rotate);
      }
      break;
    }
    default:
      for (const c of node.children) if (c.tag !== "#text") walk(ctx, c, s);
  }
  if (clipRect !== undefined) ctx.ops.push("Q");
}

function collect(node: Node, ctx: Context): void {
  if (node.tag === "clipPath" && node.attrs.id !== undefined) {
    const rect = node.children.find((c) => c.tag === "rect");
    if (rect !== undefined) ctx.clips.set(node.attrs.id, rect);
  }
  if (node.tag === "linearGradient" && node.attrs.id !== undefined) {
    ctx.gradients.set(
      node.attrs.id,
      node.children
        .filter((c) => c.tag === "stop")
        .map((c) => {
          const style = /stop-color\s*:\s*([^;]+)/.exec(c.attrs.style ?? "")?.[1]?.trim();
          return { offset: num(c.attrs.offset), color: c.attrs["stop-color"] ?? style ?? "#000000" };
        }),
    );
  }
  for (const c of node.children) collect(c, ctx);
}

// The PDF's bytes: one page the given size in points, the SVG scaled to fill it.
export function svgToPdf(markup: string, page: { width: number; height: number }): Uint8Array {
  const svg = parseSvg(markup);
  const [, , vw, vh] = (svg.attrs.viewBox ?? `0 0 ${svg.attrs.width ?? 100} ${svg.attrs.height ?? 100}`).split(/[\s,]+/).map((v) => parseFloat(v));
  const scale = page.width / vw;
  const ctx: Context = { ops: [], opacities: new Map(), clips: new Map(), gradients: new Map() };
  collect(svg, ctx);
  const base: Style = { fill: "black", stroke: null, strokeWidth: 1, dash: null, fillOpacity: 1, fontSize: 16, bold: false, anchor: "start", baseline: "auto", cap: "butt", join: "miter" };
  ctx.ops.push(`${f(scale)} 0 0 ${f(-scale)} 0 ${f(vh * scale)} cm`);
  for (const c of svg.children) if (c.tag !== "#text") walk(ctx, c, inherit(base, svg.attrs));
  const content = ctx.ops.join("\n");
  const states = [...ctx.opacities.entries()].map(([v, name]) => `/${name} << /Type /ExtGState /ca ${f(v)} >>`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(page.width)} ${f(vh * scale)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> /ExtGState << ${states} >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Producer (Binary) >>",
  ];
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
