import type { RunListFilter } from "@/lib/run-record";

// Slice A's place above the runs list: the filter by status and failure type. The list
// already reads its filter from the address (?status=, ?technique=, ?step=, ?cause=), so this
// only has to link to it. Empty until that slice is built.
export function RunFilters(_props: { filter: RunListFilter }) {
  return null;
}
