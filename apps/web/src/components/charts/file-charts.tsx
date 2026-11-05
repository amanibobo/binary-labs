"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { chartHref, newChartHref } from "@/lib/charts";
import { cn } from "@/lib/cn";
import type { FileHit } from "@/lib/domain";
import { ChartIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { buttonVariants } from "../ui/button";
import { When } from "../ui/when";

export const fileChartsKey = (sha: string) => ["file-charts", sha] as const;

// On a data sheet's opened row: the way into the chart builder.
export function MakeChartLink({ hit }: { hit: FileHit }) {
  return (
    <Link href={newChartHref(hit.locations[0].id)} className={cn(buttonVariants({ variant: "tertiary", size: "compact" }), "-ml-3 text-content-secondary")}>
      <ChartIcon className="size-5" />
      Make a chart
    </Link>
  );
}

// And the charts already made from it, when there are any.
export function FileCharts({ hit }: { hit: FileHit }) {
  const api = useLabApi();
  const query = useQuery({ queryKey: fileChartsKey(hit.sha256), queryFn: ({ signal }) => api.fileCharts(hit.sha256, signal) });
  const charts = query.data ?? [];
  if (charts.length === 0) return null;
  return (
    <div className="w-full min-w-0">
      <h3 className="text-label-medium text-content-primary">Charts</h3>
      <ul className="mt-2 grid gap-2">
        {charts.map((c) => (
          <li key={c.id} className="min-w-0">
            <Link href={chartHref(c.id)} className="text-paragraph-small text-content-accent underline-offset-2 hover:underline">
              {c.title}
            </Link>
            <p className="mt-0.5 text-paragraph-xsmall text-content-tertiary">
              Saved <When iso={c.updatedAt} />
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
