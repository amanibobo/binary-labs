import type { FileKind, FileLocation, MatchReason, SourceKind } from "./domain";

const DATE_PARTS = { month: "short", day: "numeric", year: "numeric" } as const;
const dayFormat = new Intl.DateTimeFormat("en-US", { ...DATE_PARTS, timeZone: "UTC" });

// A calendar day ("2026-10-14"), such as a label's date: the same day wherever it's read.
export function formatDay(day: string): string {
  return dayFormat.format(new Date(`${day}T00:00:00Z`));
}

// A moment, such as when a file was saved: the day it was where the reader is.
// Leave timeZone out to use the runtime's own zone.
export function formatInstant(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { ...DATE_PARTS, timeZone }).format(new Date(iso));
}

export function folderOf(location: FileLocation): string {
  const cut = location.path.lastIndexOf("/");
  return cut <= 0 ? "/" : location.path.slice(0, cut);
}

export function matchLine(reasons: readonly MatchReason[]): string | null {
  const words = reasons.includes("words");
  const meaning = reasons.includes("meaning");
  if (words && meaning) return "Matched by name and content, and by meaning";
  if (words) return "Matched by name and content";
  if (meaning) return "Matched by meaning";
  return null;
}

export function otherPlacesLine(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? "Also in 1 other place" : `Also in ${count} other places`;
}

export function openInDropboxUrl(path: string): string {
  return `https://www.dropbox.com/home${path.split("/").map(encodeURIComponent).join("/")}`;
}

export type OpenTarget = { href: string; label: string };

// Where "Open" takes a file: Dropbox files open in Dropbox, files we hold come from our
// store, and a local dev folder has nowhere to go.
const OPEN_TARGETS = {
  dropbox: (l) => ({ href: openInDropboxUrl(l.path), label: "Open in Dropbox" }),
  upload: (l) => ({ href: `/api/files/${l.id}`, label: "Open file" }),
  local: () => null,
} satisfies Record<SourceKind, (location: FileLocation) => OpenTarget | null>;

export function openTarget(location: FileLocation): OpenTarget | null {
  return OPEN_TARGETS[location.sourceKind](location);
}

export const KIND_LABELS = {
  pdf: "PDF",
  spreadsheet: "Spreadsheet",
  document: "Document",
  text: "Text",
  image: "Image",
  other: "Other",
  audio: "Audio",
  video: "Video",
} satisfies Record<FileKind, string>;

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${UNITS[unit]}`;
}

export function countLine(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
