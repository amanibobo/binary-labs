import type { FileHit } from "./domain";
import type { LabLists } from "./label-edit";

// Searches to suggest on the empty home screen, in the lab's own words: the experiments,
// people and instruments on recent files first (taking one of each in turn, so the row
// shows the range), then the lab's experiment and people lists.
export function exampleQueries(recent: readonly Pick<FileHit, "label">[], lists: LabLists, max = 4): string[] {
  const labels = recent.flatMap((hit) => (hit.label === null ? [] : [hit.label]));
  const fromRecent = interleave([
    labels.map((l) => l.experiment?.name),
    labels.map((l) => l.person?.name),
    labels.map((l) => l.instrument ?? undefined),
  ]);
  const fromLists = interleave([lists.experiments.map((e) => e.name), lists.people.map((p) => p.name)]);

  const seen = new Set<string>();
  const picked: string[] = [];
  for (const name of [...fromRecent, ...fromLists]) {
    const key = name.trim().toLowerCase();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    picked.push(name.trim());
    if (picked.length === max) break;
  }
  return picked;
}

// Distinct values from each column, taken one column at a time: a1, b1, c1, a2, b2, …
function interleave(columns: readonly (readonly (string | undefined)[])[]): string[] {
  const distinct = columns.map((column) => [...new Set(column.filter((v): v is string => v !== undefined))]);
  const rows = Math.max(0, ...distinct.map((c) => c.length));
  return Array.from({ length: rows }, (_, i) => distinct.flatMap((c) => (i < c.length ? [c[i]] : []))).flat();
}
