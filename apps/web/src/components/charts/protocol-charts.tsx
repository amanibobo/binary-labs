"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId } from "react";
import { chartHref, type SavedChart } from "@/lib/charts";
import type { LocationId } from "@/lib/ids";
import { useLabApi } from "../lab-api";
import { Skeleton } from "../ui/skeleton";
import { tableKey, fileHref } from "./chart-builder";
import { ChartFigure } from "./chart-figure";

export type ProtocolChart = { chart: SavedChart; file: { name: string; locationId: LocationId } | null };

// The charts linked to a protocol, each drawn from its file's table.
export function ProtocolCharts({ charts }: { charts: readonly ProtocolChart[] }) {
  const headingId = useId();
  if (charts.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="mt-14">
      <h2 id={headingId} className="text-heading-xsmall">
        Charts
      </h2>
      <ul className="mt-4 grid gap-10">
        {charts.map((c) => (
          <LinkedChart key={c.chart.id} item={c} />
        ))}
      </ul>
    </section>
  );
}

function LinkedChart({ item }: { item: ProtocolChart }) {
  const api = useLabApi();
  const { chart, file } = item;
  const query = useQuery({ queryKey: tableKey(chart.sha256), queryFn: ({ signal }) => api.dataTable(chart.sha256, signal) });
  const table = query.data?.state === "ready" ? query.data.tables.tables.find((t) => t.name === chart.sheet) : undefined;
  return (
    <li className="min-w-0">
      <Link href={chartHref(chart.id)} className="text-label-large text-content-primary underline-offset-2 hover:underline">
        {chart.title}
      </Link>
      {file === null ? null : (
        <p className="mt-0.5 text-paragraph-small text-content-tertiary">
          From{" "}
          <Link href={fileHref({ ...file, sha256: chart.sha256 })} className="font-mono text-paragraph-xsmall text-content-secondary hover:underline">
            {file.name}
          </Link>
        </p>
      )}
      <div className="mt-4">
        {table !== undefined ? (
          <ChartFigure spec={chart.spec} table={table} label={chart.title} />
        ) : query.data === undefined || query.data.state === "waiting" || query.data.state === "missing" ? (
          <Skeleton className="h-72 w-full rounded-card" />
        ) : (
          <p className="text-paragraph-small text-content-tertiary">This chart&apos;s table can&apos;t be read right now.</p>
        )}
      </div>
    </li>
  );
}
