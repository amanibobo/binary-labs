import type { FileHit, SearchFilters } from "./domain";

export function hasFilters(filters: SearchFilters): boolean {
  return Object.values(filters).some((v) => v !== undefined);
}

// Recent files are already on the client, so filters apply to them here with
// the same rules search_files uses (prefix on path, inclusive day range).
export function matchesFilters(hit: FileHit, filters: SearchFilters): boolean {
  if (filters.kind !== undefined && hit.fileKind !== filters.kind) return false;
  return hit.locations.some((location) => {
    const prefix = filters.prefix?.toLowerCase();
    if (prefix !== undefined && !location.path.toLowerCase().startsWith(prefix)) return false;
    const day = location.modifiedAt.slice(0, 10);
    if (filters.from !== undefined && day < filters.from) return false;
    if (filters.to !== undefined && day > filters.to) return false;
    return true;
  });
}
