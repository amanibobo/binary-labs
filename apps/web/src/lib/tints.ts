import type { FileKind } from "./domain";

export const TINTS = ["purple", "blue", "yellow", "orange", "green", "gray"] as const;
export type Tint = (typeof TINTS)[number];
export type Shade = "base" | "soft";

// Full class names so Tailwind sees them; the CSS variables live in globals.css.
export const TINT_STYLE = {
  purple: { icon: "text-tint-purple", iconSoft: "text-tint-purple-soft", avatar: "bg-tint-purple-wash text-tint-purple-ink", fill: "var(--tint-purple)", fillSoft: "var(--tint-purple-soft)" },
  blue: { icon: "text-tint-blue", iconSoft: "text-tint-blue-soft", avatar: "bg-tint-blue-wash text-tint-blue-ink", fill: "var(--tint-blue)", fillSoft: "var(--tint-blue-soft)" },
  yellow: { icon: "text-tint-yellow", iconSoft: "text-tint-yellow-soft", avatar: "bg-tint-yellow-wash text-tint-yellow-ink", fill: "var(--tint-yellow)", fillSoft: "var(--tint-yellow-soft)" },
  orange: { icon: "text-tint-orange", iconSoft: "text-tint-orange-soft", avatar: "bg-tint-orange-wash text-tint-orange-ink", fill: "var(--tint-orange)", fillSoft: "var(--tint-orange-soft)" },
  green: { icon: "text-tint-green", iconSoft: "text-tint-green-soft", avatar: "bg-tint-green-wash text-tint-green-ink", fill: "var(--tint-green)", fillSoft: "var(--tint-green-soft)" },
  gray: { icon: "text-tint-gray", iconSoft: "text-tint-gray-soft", avatar: "bg-tint-gray-wash text-tint-gray-ink", fill: "var(--tint-gray)", fillSoft: "var(--tint-gray-soft)" },
} as const satisfies Record<Tint, { icon: string; iconSoft: string; avatar: string; fill: string; fillSoft: string }>;

export const KIND_TINT = {
  pdf: "orange",
  spreadsheet: "green",
  document: "blue",
  text: "gray",
  image: "purple",
  other: "gray",
  audio: "yellow",
  video: "blue",
} as const satisfies Record<FileKind, Tint>;

// FNV-1a: stable across runtimes, so server and client pick the same tint.
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tintFor(key: string): Tint {
  return TINTS[hash(key.toLowerCase()) % TINTS.length] ?? "gray";
}

export type FolderTint = { tint: Tint; shade: Shade };

// Top-level folders take these in name order, so the first six in a lab never share a color.
export const FOLDER_TINTS = ["blue", "purple", "green", "orange", "yellow", "gray"] as const satisfies readonly Tint[];

export function folderIconClass({ tint, shade }: FolderTint): string {
  return shade === "base" ? TINT_STYLE[tint].icon : TINT_STYLE[tint].iconSoft;
}
