import { useId } from "react";

export type Shading = { id: string; front: string; back: string; paper: string };

// Gradient ids that stay unique when the same drawing renders twice on a page.
export function useShading(): Shading {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return { id, front: `url(#${id}-front)`, back: `url(#${id}-back)`, paper: `url(#${id}-paper)` };
}

// The light every illustration shares: a front face lit from above, a darker
// back face, and paper that greys slightly toward the bottom.
export function ShadingDefs({ shading: { id }, fill }: { shading: Shading; fill: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-front`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={{ stopColor: `color-mix(in oklab, ${fill} 70%, white)` }} />
        <stop offset="0.55" style={{ stopColor: fill }} />
        <stop offset="1" style={{ stopColor: `color-mix(in oklab, ${fill} 82%, black)` }} />
      </linearGradient>
      <linearGradient id={`${id}-back`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={{ stopColor: `color-mix(in oklab, ${fill} 72%, black)` }} />
        <stop offset="1" style={{ stopColor: `color-mix(in oklab, ${fill} 55%, black)` }} />
      </linearGradient>
      <linearGradient id={`${id}-paper`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style={{ stopColor: "var(--paper)" }} />
        <stop offset="1" style={{ stopColor: "color-mix(in oklab, var(--paper) 88%, var(--paper-line))" }} />
      </linearGradient>
    </defs>
  );
}

// A sheet of paper with a folded corner and three lines of text, 62 by 78. A sheet
// that sits on the page rather than on a tint takes an edge, or it vanishes on white.
export function Sheet({ x, y, rotate, paper, edge = false }: { x: number; y: number; rotate: number; paper: string; edge?: boolean }) {
  return (
    <g transform={`rotate(${rotate} ${x + 31} ${y + 40})`}>
      <path
        d={`M${x + 6} ${y}h42l14 14v58a6 6 0 0 1-6 6H${x + 6}a6 6 0 0 1-6-6V${y + 6}a6 6 0 0 1 6-6z`}
        fill={paper}
        stroke={edge ? "var(--paper-line)" : undefined}
        strokeWidth={edge ? 1.5 : undefined}
      />
      <path d={`M${x + 48} ${y}v9a5 5 0 0 0 5 5h9z`} fill="var(--paper-line)" opacity="0.6" />
      <path
        d={`M${x + 10} ${y + 15}h26M${x + 10} ${y + 23}h40M${x + 10} ${y + 31}h34`}
        stroke="var(--paper-line)"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </g>
  );
}
