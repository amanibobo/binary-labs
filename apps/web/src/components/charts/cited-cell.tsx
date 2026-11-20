"use client";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { findCitedCell, type CitedCell } from "@/lib/charts";
import { formatValue } from "@/lib/chart-geometry";
import { cellText, columnLabel, type DataTable } from "@/lib/data-tables";

// The cell an answer cited, opened from its citation (decisions.md, "charts round 2"): a few rows
// of its sheet around it, the cell outlined, so a student sees the number the answer used and
// where it sits before charting it.

const AROUND = 2;
const COLUMNS = 6;

export function CitedCellView({ tables, cell }: { tables: readonly DataTable[]; cell: CitedCell }) {
  const found = findCitedCell(tables, cell);
  const marked = useRef<HTMLTableCellElement>(null);
  useEffect(() => {
    marked.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);
  if (found === null) {
    return (
      <p role="status" className="mt-4 rounded-control bg-background-secondary px-4 py-3 text-paragraph-small text-content-secondary">
        The answer cited {cell.sheet}, {cell.column}, row {cell.row}, but the file reads differently now, so it can&apos;t be marked.
      </p>
    );
  }
  const { table, column, row } = found;
  const at = table.columns.indexOf(column);
  const start = Math.max(0, Math.min(at - 1, table.columns.length - COLUMNS));
  const columns = table.columns.slice(start, start + COLUMNS);
  const rows = Array.from({ length: Math.min(table.rows, row + AROUND + 1) - Math.max(0, row - AROUND) }, (_, i) => Math.max(0, row - AROUND) + i);
  const value = cellText(column, row, formatValue);
  return (
    <section aria-label="The cell the answer cited" className="mt-4 rounded-control bg-background-secondary px-4 py-3">
      <p className="text-paragraph-small text-content-secondary">
        The answer used <span className="text-label-small text-content-primary">{value === "" ? "an empty cell" : value}</span> from {table.name}, {columnLabel(column)}, row {row + 1}. It&apos;s outlined below{column.kind === "number" ? ", and ringed on the chart when the chart draws it" : ""}.
      </p>
      <div className="mt-3 overflow-x-auto rounded-control border border-border-opaque bg-background-primary">
        <table className="w-full text-left text-paragraph-xsmall tabular-nums">
          <thead>
            <tr>
              <th scope="col" className="px-3 py-1.5 font-medium text-content-tertiary">
                Row
              </th>
              {columns.map((c) => (
                <th key={c.id} scope="col" className={cn("px-3 py-1.5 font-medium whitespace-nowrap", c.id === column.id ? "text-content-primary" : "text-content-secondary")}>
                  {columnLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r} className={cn("border-t border-border-opaque", r === row && "bg-background-secondary")}>
                <th scope="row" className="px-3 py-1.5 font-medium text-content-tertiary">
                  {r + 1}
                </th>
                {columns.map((c) => {
                  const cited = r === row && c.id === column.id;
                  return (
                    <td
                      key={c.id}
                      ref={cited ? marked : undefined}
                      aria-current={cited ? "true" : undefined}
                      className={cn("px-3 py-1.5 whitespace-nowrap text-content-primary", cited && "font-semibold outline-2 -outline-offset-2 outline-border-selected")}
                    >
                      {cellText(c, r, formatValue)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
