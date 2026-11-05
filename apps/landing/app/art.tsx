import { useId } from "react";
import type { Kind } from "./samples";

// Ported from the web app's illustration kit (apps/web/src/components/art) with its tints inlined,
// so the landing page draws the same folders and objects without depending on the app.
export const TINT = {
  blue: "#3f78e0",
  purple: "#7a68d6",
  green: "#3d9c62",
  orange: "#e06b35",
  yellow: "#d9a520",
  gray: "#8a8a90",
} as const;
export type Tint = keyof typeof TINT;

const PAPER = "#ffffff";
const PAPER_LINE = "#d4d4d8";

type Shading = { id: string; front: string; back: string; paper: string };

function useShading(): Shading {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return { id, front: `url(#${id}-front)`, back: `url(#${id}-back)`, paper: `url(#${id}-paper)` };
}

function ShadingDefs({ shading: { id }, fill }: { shading: Shading; fill: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-front`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={`color-mix(in oklab, ${fill} 70%, white)`} />
        <stop offset="0.55" stopColor={fill} />
        <stop offset="1" stopColor={`color-mix(in oklab, ${fill} 82%, black)`} />
      </linearGradient>
      <linearGradient id={`${id}-back`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={`color-mix(in oklab, ${fill} 72%, black)`} />
        <stop offset="1" stopColor={`color-mix(in oklab, ${fill} 55%, black)`} />
      </linearGradient>
      <linearGradient id={`${id}-paper`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={PAPER} />
        <stop offset="1" stopColor={`color-mix(in oklab, ${PAPER} 88%, ${PAPER_LINE})`} />
      </linearGradient>
    </defs>
  );
}

function Sheet({ x, y, rotate, paper, edge = false }: { x: number; y: number; rotate: number; paper: string; edge?: boolean }) {
  return (
    <g transform={`rotate(${rotate} ${x + 31} ${y + 40})`}>
      <path
        d={`M${x + 6} ${y}h42l14 14v58a6 6 0 0 1-6 6H${x + 6}a6 6 0 0 1-6-6V${y + 6}a6 6 0 0 1 6-6z`}
        fill={paper}
        stroke={edge ? PAPER_LINE : undefined}
        strokeWidth={edge ? 1.5 : undefined}
      />
      <path d={`M${x + 48} ${y}v9a5 5 0 0 0 5 5h9z`} fill={PAPER_LINE} opacity="0.6" />
      <path d={`M${x + 10} ${y + 15}h26M${x + 10} ${y + 23}h40M${x + 10} ${y + 31}h34`} stroke={PAPER_LINE} strokeWidth="3.5" strokeLinecap="round" />
    </g>
  );
}

const highlight = { stroke: "white", strokeOpacity: 0.4, strokeWidth: 1.5, strokeLinecap: "round", fill: "none" } as const;
const ink = { stroke: PAPER_LINE, strokeWidth: 3.5, strokeLinecap: "round" } as const;

const FOLDER_BACK = "M10 30a8 8 0 0 1 8-8h33.5a8 8 0 0 1 6.1 2.83L63 31.2h79a8 8 0 0 1 8 8V104a10 10 0 0 1-10 10H20a10 10 0 0 1-10-10z";
const FOLDER_FRONT = "M6 58a9 9 0 0 1 9-9h130a9 9 0 0 1 9 9v46a12 12 0 0 1-12 12H18A12 12 0 0 1 6 104z";

export function FolderArt({ tint, className }: { tint: Tint; className?: string }) {
  const s = useShading();
  return (
    <svg viewBox="0 0 160 120" aria-hidden focusable="false" className={className}>
      <ShadingDefs shading={s} fill={TINT[tint]} />
      <path d={FOLDER_BACK} fill={s.back} />
      <Sheet x={22} y={8} rotate={-8} paper={s.paper} />
      <Sheet x={76} y={6} rotate={7} paper={s.paper} />
      <path d={FOLDER_FRONT} fill={s.front} />
      <path d="M16 50.5h128" {...highlight} />
    </svg>
  );
}

const FLASK = "M68 14h24v32l38 50a11 11 0 0 1-8.8 17.6H38.8A11 11 0 0 1 30 96l38-50z";

export function FlaskArt({ tint = "green", className }: { tint?: Tint; className?: string }) {
  const s = useShading();
  const fill = TINT[tint];
  return (
    <svg viewBox="0 0 160 120" aria-hidden focusable="false" className={className}>
      <ShadingDefs shading={s} fill={fill} />
      <clipPath id={`${s.id}-flask`}>
        <path d={FLASK} />
      </clipPath>
      <path d={FLASK} fill={`color-mix(in oklab, ${fill} 22%, ${PAPER})`} />
      <rect x="20" y="70" width="120" height="50" fill={s.front} clipPath={`url(#${s.id}-flask)`} />
      <path d="M52.5 71.5h55" {...highlight} />
      <circle cx="70" cy="90" r="4" fill="white" fillOpacity="0.35" />
      <circle cx="88" cy="99" r="2.75" fill="white" fillOpacity="0.3" />
      <circle cx="94" cy="84" r="2" fill="white" fillOpacity="0.3" />
      <path d="M78 26v20" {...ink} opacity="0.7" />
      <rect x="61" y="8" width="38" height="11" rx="5.5" fill={s.back} />
    </svg>
  );
}

export function BinArt({ className }: { className?: string }) {
  const s = useShading();
  return (
    <svg viewBox="0 0 160 120" aria-hidden focusable="false" className={className}>
      <ShadingDefs shading={s} fill={TINT.gray} />
      <Sheet x={50} y={6} rotate={8} paper={s.paper} edge />
      <path d="M38 42h84l-7.2 64.8A8 8 0 0 1 106.9 114H53.1a8 8 0 0 1-7.9-7.2z" fill={s.front} />
      <path d="M41 45.5h78" {...highlight} />
      <path d="M66 58v42M80 58v42M94 58v42" stroke="white" strokeOpacity="0.3" strokeWidth="3" strokeLinecap="round" />
      <rect x="30" y="34" width="100" height="12" rx="6" fill={s.back} />
    </svg>
  );
}

export function BadgeArt({ className }: { className?: string }) {
  const s = useShading();
  return (
    <svg viewBox="0 0 160 120" aria-hidden focusable="false" className={className}>
      <ShadingDefs shading={s} fill={TINT.orange} />
      <rect x="66" y="10" width="28" height="30" rx="6" fill={s.back} />
      <rect x="22" y="28" width="116" height="86" rx="13" fill={s.front} />
      <path d="M34 31.5h92" {...highlight} />
      <rect x="69" y="36" width="22" height="6" rx="3" fill={s.back} />
      <rect x="34" y="52" width="92" height="50" rx="8" fill={s.paper} />
      <circle cx="58" cy="71" r="9" fill={s.back} opacity="0.85" />
      <path d="M43 96a15 13 0 0 1 30 0z" fill={s.back} opacity="0.85" />
      <path d="M82 68h32M82 80h22" {...ink} />
    </svg>
  );
}

export function CloudArt({ className }: { className?: string }) {
  const s = useShading();
  return (
    <svg viewBox="0 0 160 120" aria-hidden focusable="false" className={className}>
      <ShadingDefs shading={s} fill={TINT.blue} />
      <clipPath id={`${s.id}-cloud`}>
        <circle cx="46" cy="84" r="23" />
        <circle cx="80" cy="64" r="32" />
        <circle cx="114" cy="80" r="25" />
        <rect x="23" y="80" width="116" height="30" rx="15" />
      </clipPath>
      <Sheet x={20} y={14} rotate={-12} paper={s.paper} edge />
      <Sheet x={82} y={12} rotate={10} paper={s.paper} edge />
      <rect x="23" y="32" width="116" height="78" fill={s.front} clipPath={`url(#${s.id}-cloud)`} />
      <path d="M54.4 53.3A28 28 0 0 1 74.6 36.5" {...highlight} />
    </svg>
  );
}

// A six-place centrifuge rotor seen from above. It spins while the pointer is on it.
export function RotorArt({ className }: { className?: string }) {
  const s = useShading();
  return (
    <svg viewBox="0 0 48 48" aria-hidden focusable="false" className={className}>
      <ShadingDefs shading={s} fill={TINT.gray} />
      <circle cx="24" cy="24" r="22" fill={s.front} />
      <circle cx="24" cy="24" r="22" fill="none" stroke="rgb(0 0 0 / 0.25)" strokeWidth="1" />
      {[0, 60, 120, 180, 240, 300].map((deg, i) => (
        <circle
          key={deg}
          cx={(24 + 13 * Math.cos((deg * Math.PI) / 180)).toFixed(2)}
          cy={(24 + 13 * Math.sin((deg * Math.PI) / 180)).toFixed(2)}
          r="4.2"
          fill={i % 3 === 0 ? TINT.orange : i % 3 === 1 ? TINT.blue : TINT.yellow}
          stroke="rgb(0 0 0 / 0.3)"
          strokeWidth="0.75"
        />
      ))}
      <circle cx="24" cy="24" r="4" fill={s.back} />
      <path d="M10 16a16 16 0 0 1 10-8" {...highlight} strokeOpacity="0.7" />
    </svg>
  );
}

// An agarose gel under blue light: a ladder, then sample lanes. Band heights run 0 (top) to 1.
const GEL_LANES: readonly (readonly number[])[] = [
  [0.14, 0.24, 0.33, 0.45, 0.58, 0.7, 0.8],
  [0.36, 0.62],
  [0.36, 0.62],
  [0.38],
  [0.36, 0.62, 0.74],
  [0.36, 0.62],
  [0.5],
  [0.36, 0.6],
];

export function GelArt({ className, focusLane }: { className?: string; focusLane?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const w = 320;
  const h = 220;
  const laneW = 28;
  const gap = (w - 32 - GEL_LANES.length * laneW) / (GEL_LANES.length - 1);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false" className={className}>
      <defs>
        <radialGradient id={`${id}-bg`} cx="0.5" cy="0.45" r="0.75">
          <stop offset="0" stopColor="#1b2d63" />
          <stop offset="1" stopColor="#070b1c" />
        </radialGradient>
        <filter id={`${id}-glow`} x="-20%" y="-200%" width="140%" height="500%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>
      <rect width={w} height={h} fill={`url(#${id}-bg)`} />
      {GEL_LANES.map((bands, lane) => {
        const x = 16 + lane * (laneW + gap);
        return (
          <g key={lane}>
            <rect x={x} y="14" width={laneW} height="6" rx="1.5" fill="#0a1230" stroke="#2b3d78" strokeWidth="0.75" />
            {bands.map((b) => (
              <rect
                key={b}
                x={x + 2}
                y={20 + b * (h - 34)}
                width={laneW - 4}
                height={lane === 0 ? 3 : 5}
                rx="2"
                fill={lane === focusLane ? "#f6ffcf" : "#d8f2ff"}
                opacity={lane === 0 ? 0.65 : 0.92}
                filter={`url(#${id}-glow)`}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

// A 96-well plate after a Bradford assay: blue where there is more protein.
export function PlateArt({ className }: { className?: string }) {
  const rows = 8;
  const cols = 12;
  return (
    <svg viewBox="0 0 260 180" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false" className={className}>
      <rect width="260" height="180" fill="#eef0f3" />
      <rect x="10" y="10" width="240" height="160" rx="10" fill="#fdfdfd" stroke="#c9ccd3" />
      {Array.from({ length: rows * cols }, (_, i) => {
        const r = Math.floor(i / cols);
        const c = i % cols;
        const level = c < 2 ? (7 - r) / 7 : ((r * 5 + c * 7) % 11) / 10;
        return (
          <circle
            key={i}
            cx={28 + c * 18.6}
            cy={28 + r * 17.8}
            r="7"
            fill={`color-mix(in oklab, #3550c8 ${Math.round(18 + level * 70)}%, #e6c76a)`}
            stroke="rgb(0 0 0 / 0.15)"
            strokeWidth="0.75"
          />
        );
      })}
    </svg>
  );
}

// A notebook page with handwriting, drawn as strokes.
export function NotebookArt({ className, drawn = true }: { className?: string; drawn?: boolean }) {
  const lines = [
    "M18 40c10-4 18 3 28-1s16-3 24 0 14-2 22 1",
    "M18 64c8-3 16 2 26-1s20 2 30-1",
    "M18 88c12-3 20 3 34 0s14-2 22 1 10 0 18-2",
    "M18 112c10-3 16 2 24 0",
    "M18 136c9-2 17 3 27 0s15-2 23 1 12-1 18 0",
    "M18 160c11-3 19 2 29-1",
    "M18 184c8-2 18 3 28 0s16-2 24 1",
  ];
  return (
    <svg viewBox="0 0 120 220" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false" className={className}>
      <rect width="120" height="220" fill="#fbf8ef" />
      {Array.from({ length: 9 }, (_, i) => (
        <path key={i} d={`M0 ${28 + i * 24}h120`} stroke="#b9d3ea" strokeWidth="0.8" />
      ))}
      <path d="M12 0v220" stroke="#e7a1a1" strokeWidth="0.9" />
      {lines.map((d, i) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="#25407a"
          strokeWidth="1.6"
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="1"
          strokeDashoffset={drawn ? 0 : 1}
          style={{ transition: `stroke-dashoffset 0.6s ease ${i * 0.25}s` }}
        />
      ))}
      <rect x="70" y="150" width="34" height="22" rx="2" fill="#0c1430" />
      <path d="M74 156h4M74 160h4M82 157h4M90 161h4M98 158h4" stroke="#d8f2ff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// The first page of a protocol: a title, a note, numbered steps.
export function ProtocolArt({ className, step }: { className?: string; step?: number }) {
  return (
    <svg viewBox="0 0 220 150" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false" className={className}>
      <rect width="220" height="150" fill="#fff" />
      <rect x="14" y="14" width="96" height="8" rx="3" fill="#1d1d1f" />
      <rect x="14" y="28" width="60" height="5" rx="2.5" fill="#c9c9ce" />
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i}>
          <rect
            x="10"
            y={44 + i * 20}
            width="200"
            height="16"
            rx="4"
            fill={step === i ? "#e5eefd" : "transparent"}
            style={{ transition: "fill 0.3s" }}
          />
          <circle cx="22" cy={52 + i * 20} r="5" fill={step === i ? TINT.blue : "#e4e4e7"} style={{ transition: "fill 0.3s" }} />
          <rect x="34" y={49 + i * 20} width={[120, 150, 96, 136, 110][i]} height="5" rx="2.5" fill="#a1a1aa" />
        </g>
      ))}
    </svg>
  );
}

const KIND_TINT = { pdf: "orange", spreadsheet: "green", document: "blue", image: "purple" } as const satisfies Record<Kind, Tint>;

export function KindIcon({ kind }: { kind: Kind }) {
  const tint = TINT[KIND_TINT[kind]];
  return (
    <span className="grid size-[30px] shrink-0 place-items-center rounded-[8px]" style={{ background: `color-mix(in oklab, ${tint} 14%, white)` }}>
      <svg viewBox="0 0 16 16" className="size-[15px]" aria-hidden>
        <path d="M4 1.5h5l3.5 3.5v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" fill="none" stroke={tint} strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M5.5 8.5h5M5.5 11h3.5" stroke={tint} strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </span>
  );
}
