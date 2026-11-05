import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { TINT_STYLE, type Tint } from "@/lib/tints";
import type { SettingsArea } from "@/app/lab/areas";
import { ShadingDefs, Sheet, useShading, type Shading } from "./kit";

const highlight = { stroke: "white", strokeOpacity: 0.4, strokeWidth: 1.5, strokeLinecap: "round", fill: "none" } as const;
const ink = { stroke: "var(--paper-line)", strokeWidth: 3.5, strokeLinecap: "round" } as const;

// Files in the cloud: two sheets tucked behind a cloud. Not the Dropbox logo.
function Dropbox(s: Shading) {
  return (
    <>
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
    </>
  );
}

const FLASK = "M68 14h24v32l38 50a11 11 0 0 1-8.8 17.6H38.8A11 11 0 0 1 30 96l38-50z";

// A flask, half full.
function Experiments(s: Shading, fill: string) {
  return (
    <>
      <clipPath id={`${s.id}-flask`}>
        <path d={FLASK} />
      </clipPath>
      <path d={FLASK} style={{ fill: `color-mix(in oklab, ${fill} 22%, var(--paper))` }} />
      <rect x="20" y="70" width="120" height="50" fill={s.front} clipPath={`url(#${s.id}-flask)`} />
      <path d="M52.5 71.5h55" {...highlight} />
      <circle cx="70" cy="90" r="4" fill="white" fillOpacity="0.35" />
      <circle cx="88" cy="99" r="2.75" fill="white" fillOpacity="0.3" />
      <circle cx="94" cy="84" r="2" fill="white" fillOpacity="0.3" />
      <path d="M78 26v20" {...ink} opacity="0.7" />
      <rect x="61" y="8" width="38" height="11" rx="5.5" fill={s.back} />
    </>
  );
}

// A name badge on a clip: how a person shows up on files.
function People(s: Shading) {
  return (
    <>
      <rect x="66" y="10" width="28" height="30" rx="6" fill={s.back} />
      <rect x="22" y="28" width="116" height="86" rx="13" fill={s.front} />
      <path d="M34 31.5h92" {...highlight} />
      <rect x="69" y="36" width="22" height="6" rx="3" fill={s.back} />
      <rect x="34" y="52" width="92" height="50" rx="8" fill={s.paper} />
      <circle cx="58" cy="71" r="9" fill={s.back} opacity="0.85" />
      <path d="M43 96a15 13 0 0 1 30 0z" fill={s.back} opacity="0.85" />
      <path d="M82 68h32M82 80h22" {...ink} />
    </>
  );
}

// Two people, one in front of the other.
function Members(s: Shading) {
  return (
    <>
      <circle cx="106" cy="40" r="17" fill={s.back} />
      <path d="M72 104a34 32 0 0 1 68 0v2a6 6 0 0 1-6 6H78a6 6 0 0 1-6-6z" fill={s.back} />
      <circle cx="62" cy="50" r="20" fill={s.front} />
      <path d="M22 110a40 37 0 0 1 80 0a6 6 0 0 1-6 6H28a6 6 0 0 1-6-6z" fill={s.front} />
      <path d="M48.5 39.5a15 15 0 0 1 12-6" {...highlight} />
      <path d="M36 84a32 30 0 0 1 22-10" {...highlight} />
    </>
  );
}

// A key, tilted: your sign-in.
function Account(s: Shading) {
  return (
    <g transform="rotate(-12 80 62) translate(-5 0)">
      <clipPath id={`${s.id}-key`}>
        <circle cx="56" cy="62" r="30" />
        <rect x="76" y="54" width="68" height="16" rx="8" />
        <rect x="112" y="62" width="11" height="24" rx="4" />
        <rect x="130" y="62" width="11" height="18" rx="4" />
      </clipPath>
      <rect x="26" y="32" width="118" height="60" fill={s.front} clipPath={`url(#${s.id}-key)`} />
      <circle cx="49" cy="62" r="10" fill={s.back} />
      <path d="M36.5 44.5a24 24 0 0 1 22-9" {...highlight} />
      <path d="M84 57.5h52" {...highlight} />
    </g>
  );
}

// A bin with a sheet in it, drawn quiet.
function Delete(s: Shading) {
  return (
    <>
      <Sheet x={50} y={6} rotate={8} paper={s.paper} edge />
      <path d="M38 42h84l-7.2 64.8A8 8 0 0 1 106.9 114H53.1a8 8 0 0 1-7.9-7.2z" fill={s.front} />
      <path d="M41 45.5h78" {...highlight} />
      <path d="M66 58v42M80 58v42M94 58v42" stroke="white" strokeOpacity="0.3" strokeWidth="3" strokeLinecap="round" />
      <rect x="30" y="34" width="100" height="12" rx="6" fill={s.back} />
    </>
  );
}

// A sun half in shadow: light on the left, dark on the right.
function Appearance(s: Shading) {
  return (
    <>
      <clipPath id={`${s.id}-half`}>
        <rect x="80" y="0" width="80" height="120" />
      </clipPath>
      <circle cx="80" cy="62" r="44" fill={s.paper} stroke="var(--paper-line)" strokeWidth="1.5" />
      <circle cx="80" cy="62" r="44" fill={s.front} clipPath={`url(#${s.id}-half)`} />
      <path d="M52 34a40 40 0 0 1 22-11" {...highlight} />
    </>
  );
}

const ART = {
  dropbox: { tint: "blue", draw: Dropbox },
  experiments: { tint: "green", draw: Experiments },
  people: { tint: "orange", draw: People },
  members: { tint: "purple", draw: Members },
  account: { tint: "gray", draw: Account },
  appearance: { tint: "blue", draw: Appearance },
  delete: { tint: "gray", draw: Delete },
} as const satisfies Record<SettingsArea, { tint: Tint; draw: (s: Shading, fill: string) => ReactNode }>;

// Illustrations for the settings areas, drawn like the folders: tinted, lit from above, with paper where it fits.
export function SettingsArt({ area, className }: { area: SettingsArea; className?: string }) {
  const shading = useShading();
  const { tint, draw } = ART[area];
  const fill = TINT_STYLE[tint].fill;
  return (
    <svg viewBox="0 0 160 120" aria-hidden focusable="false" className={cn("block h-auto w-full", className)}>
      <ShadingDefs shading={shading} fill={fill} />
      {draw(shading, fill)}
    </svg>
  );
}
