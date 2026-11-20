import type { FileHit, SearchFilters, SearchParams } from "./domain";

export function hasFilters(filters: SearchFilters): boolean {
  return Object.values(filters).some((v) => v !== undefined);
}

// Recent files are already on the client, so filters apply to them here with the same rules
// search_files uses (prefix on path, inclusive day range, the label's outcome and Check this).
export function matchesFilters(hit: FileHit, filters: SearchFilters): boolean {
  if (filters.kind !== undefined && hit.fileKind !== filters.kind) return false;
  // A file in Needs a look shows no outcome, so it never matches one.
  const outcome = hit.label === null || hit.label.status === "needs_look" ? null : hit.label.outcome;
  if (filters.outcome !== undefined && outcome !== filters.outcome) return false;
  if (filters.check === true && hit.label?.status !== "check") return false;
  return hit.locations.some((location) => {
    const prefix = filters.prefix?.toLowerCase();
    if (prefix !== undefined && !location.path.toLowerCase().startsWith(prefix)) return false;
    // UTC days, matching search_files and how dates are shown.
    const day = new Date(location.modifiedAt).toISOString().slice(0, 10);
    if (filters.from !== undefined && day < filters.from) return false;
    if (filters.to !== undefined && day > filters.to) return false;
    return true;
  });
}

// The query string /api/search parses back into SearchParams; Check this travels as check=true.
export function searchQueryString(params: SearchParams): string {
  const entries = Object.entries(params).flatMap(([key, value]): [string, string][] =>
    value === undefined || value === "" ? [] : [[key, String(value)]],
  );
  return new URLSearchParams(entries).toString();
}
