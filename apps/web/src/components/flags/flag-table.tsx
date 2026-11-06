"use client";

import { columnLabel, type DataColumn, type DataTable } from "@/lib/data-tables";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/checks";
import { inSpans, type Spans } from "@/lib/flags";
import type { ColumnId } from "@/lib/ids";

// The rows a flag read, with a couple either side, in the columns it read; a text column comes
// first when the table has one, so each row says what it is.
const CONTEXT = 2;
const MAX_ROWS = 60;

export type ExcerptRow = { kind: "row"; index: number; used: boolean } | { kind: "gap"; from: number; to: number };

export function excerptRows(rowCount: number, spans: Spans): ExcerptRow[] {
  const shown = new Set<number>();
  for (const [a, b] of spans) {
    for (let i = Math.max(0, a - CONTEXT); i <= Math.min(rowCount - 1, b + CONTEXT); i++) {
      if (shown.size >= MAX_ROWS) break;
      shown.add(i);
    }
  }
  const rows: ExcerptRow[] = [];
  let last = -1;
  for (const i of [...shown].toSorted((x, y) => x - y)) {
    if (i > last + 1) rows.push({ kind: "gap", from: last + 1, to: i - 1 });
    rows.push({ kind: "row", index: i, used: inSpans(spans, i) });
    last = i;
  }
  if (last < rowCount - 1 && rows.length > 0) rows.push({ kind: "gap", from: last + 1, to: rowCount - 1 });
  return rows;
}

function cellText(column: DataColumn, index: number): string {
  const v = column.values[index];
  if (v === null || v === undefined) return "";
  return typeof v === "number" ? formatNumber(v) : v;
}

export function FlagTable({ table, columns, rows, caption }: { table: DataTable; columns: readonly ColumnId[]; rows: Spans; caption: string }) {
  const used = columns.flatMap((id) => table.columns.filter((c) => c.id === id));
  const label = table.columns.find((c) => c.kind === "text" && !columns.includes(c.id));
  const shown = label === undefined ? used : [label, ...used];
  const excerpt = excerptRows(table.rows, rows);
  return (
    <div className="overflow-x-auto rounded-card border border-border-opaque bg-background-raised">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border-opaque">
            <th scope="col" className="w-14 px-3 py-2 text-label-small font-normal text-content-tertiary">
              Row
            </th>
            {shown.map((c) => (
              <th key={c.id} scope="col" className="px-3 py-2 text-label-small font-normal whitespace-nowrap text-content-tertiary">
                <span className="font-mono">{c.id}</span> {columnLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {excerpt.map((r) =>
            r.kind === "gap" ? (
              <tr key={`gap-${r.from}`} className="border-t border-border-opaque">
                <td colSpan={shown.length + 1} className="px-3 py-1.5 text-paragraph-xsmall text-content-tertiary">
                  {r.from === r.to ? `Row ${r.from + 1}` : `Rows ${r.from + 1}–${r.to + 1}`} not read
                </td>
              </tr>
            ) : (
              <tr key={r.index} className={cn("border-t border-border-opaque", r.used && "bg-background-warning text-content-warning")}>
                <td className={cn("px-3 py-1.5 font-mono text-paragraph-xsmall tabular-nums", !r.used && "text-content-tertiary")}>
                  {r.index + 1}
                  {r.used ? <span className="sr-only">, read</span> : null}
                </td>
                {shown.map((c) => (
                  <td key={c.id} className={cn("px-3 py-1.5 font-mono text-paragraph-small whitespace-nowrap tabular-nums", !r.used && "text-content-secondary")}>
                    {cellText(c, r.index)}
                  </td>
                ))}
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
