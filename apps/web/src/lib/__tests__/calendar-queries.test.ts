import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// PostgREST can only order an RPC's rows by a column the request selects; plain SQL in the db
// tests doesn't care, so a missing column only fails against the real API. This reads the
// calendar's queries and checks each .order() names a column its function's .select() asks for.

type Problem = { fn: string; column: string };

function unselectedOrders(source: string): Problem[] {
  const problems: Problem[] = [];
  for (const body of source.split(/^(?=export async function |async function |export function |function )/m)) {
    const fn = /function (\w+)/.exec(body)?.[1] ?? "(top)";
    const selected = new Set([...body.matchAll(/\.select\("([^"]*)"\)/g)].flatMap((m) => (m[1] ?? "").split(",").map((c) => c.trim())));
    for (const m of body.matchAll(/\.order\("([^"]+)"/g)) {
      const column = m[1] ?? "";
      if (!selected.has(column) && !selected.has("*")) problems.push({ fn, column });
    }
  }
  return problems;
}

describe("the calendar's supabase-js queries", () => {
  it("order only by columns they select", () => {
    const source = readFileSync(join(__dirname, "../calendar-store.ts"), "utf8");
    expect(source).toContain(".order(");
    expect(unselectedOrders(source)).toEqual([]);
  });

  it("catches the day panel's old query, which ordered by name without selecting it", () => {
    const before = `export async function loadDayFiles() {
      const base = supabase.rpc("calendar_files", args).select("sha256, kind, group_id").eq("kind", kind);
      return grouped.order("name", { ascending: true }).order("sha256");
    }`;
    expect(unselectedOrders(before)).toEqual([{ fn: "loadDayFiles", column: "name" }]);
  });
});
