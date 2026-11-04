import { useId } from "react";
import { cn } from "@/lib/cn";
import { TINT_STYLE, type FolderTint } from "@/lib/tints";

const BACK =
  "M10 30a8 8 0 0 1 8-8h33.5a8 8 0 0 1 6.1 2.83L63 31.2h79a8 8 0 0 1 8 8V104a10 10 0 0 1-10 10H20a10 10 0 0 1-10-10z";
const FRONT = "M6 58a9 9 0 0 1 9-9h130a9 9 0 0 1 9 9v46a12 12 0 0 1-12 12H18A12 12 0 0 1 6 104z";

function Sheet({ x, y, rotate, paperId }: { x: number; y: number; rotate: number; paperId: string }) {
  return (
    <g transform={`rotate(${rotate} ${x + 31} ${y + 40})`}>
      <path
        d={`M${x + 6} ${y}h42l14 14v58a6 6 0 0 1-6 6H${x + 6}a6 6 0 0 1-6-6V${y + 6}a6 6 0 0 1 6-6z`}
        fill={`url(#${paperId})`}
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

// An illustrated folder in a tint: back panel, two sheets peeking out, and a
// front panel shaded top to bottom. Vector only, so it stays crisp at any size.
export function FolderArt({ tint: { tint, shade }, className }: { tint: FolderTint; className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fill = shade === "base" ? TINT_STYLE[tint].fill : TINT_STYLE[tint].fillSoft;
  return (
    <svg viewBox="0 0 160 120" aria-hidden focusable="false" className={cn("block h-auto w-full", className)}>
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
      <path d={BACK} fill={`url(#${id}-back)`} />
      <Sheet x={22} y={8} rotate={-8} paperId={`${id}-paper`} />
      <Sheet x={76} y={6} rotate={7} paperId={`${id}-paper`} />
      <path d={FRONT} fill={`url(#${id}-front)`} />
      <path d="M16 50.5h128" stroke="white" strokeOpacity="0.4" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
