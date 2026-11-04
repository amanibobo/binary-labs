"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SearchFilters } from "@/lib/domain";
import { useDebounced } from "@/lib/use-debounced";
import { useLabApi } from "../lab-api";

export const SEARCH_DEBOUNCE_MS = 150;

// Keeps the previous results on screen while the next query loads, so the
// list never empties between keystrokes.
export function useFileSearch(query: string, filters: SearchFilters) {
  const api = useLabApi();
  const q = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const debouncedFilters = useDebounced(filters, SEARCH_DEBOUNCE_MS);
  const result = useQuery({
    queryKey: ["search", q, debouncedFilters],
    queryFn: ({ signal }) => api.search({ q, ...debouncedFilters }, signal),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });
  return { ...result, settledQuery: q };
}
