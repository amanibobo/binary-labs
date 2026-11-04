import type { FileLocation, MatchReason } from "./domain";

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
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
