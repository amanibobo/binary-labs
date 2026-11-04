"use client";

import { useQuery } from "@tanstack/react-query";
import { failedLine, isScanActive, progressFraction, progressLine, type ScanState, type SourceState } from "@/lib/source-state";
import { useLabApi } from "./lab-api";

const POLL_MS = 2000;

export function useSourceState(initial: SourceState) {
  const api = useLabApi();
  return useQuery({
    queryKey: ["source-state"],
    queryFn: ({ signal }) => api.sourceState(signal),
    initialData: initial,
    refetchInterval: (query) => {
      const state = query.state.data;
      return state?.kind === "connected" && isScanActive(state.scan) ? POLL_MS : false;
    },
  });
}

export function ScanBar({ scan }: { scan: ScanState }) {
  const line = progressLine(scan);
  const failed = failedLine(scan);
  const pct = Math.round(progressFraction(scan) * 100);
  return (
    <div>
      <div
        role="progressbar"
        aria-label="Indexing progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={line}
        className="h-1 overflow-hidden rounded-full bg-hairline"
      >
        <div
          className="h-full rounded-full bg-green transition-[width] duration-200 ease-out"
          style={{ width: `${Math.max(pct, scan.counts.pending > 0 || scan.kind === "running" ? 2 : 0)}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-muted" aria-live="polite">
        {line}
      </p>
      {failed === null ? null : <p className="text-sm text-muted">{failed}</p>}
      {scan.kind === "error" ? <p className="mt-1 text-sm text-muted">The last scan stopped: {scan.message}</p> : null}
    </div>
  );
}

export function ActiveScan({ initial }: { initial: SourceState }) {
  const { data } = useSourceState(initial);
  if (data.kind !== "connected" || !isScanActive(data.scan)) return null;
  return (
    <div className="mb-6">
      <ScanBar scan={data.scan} />
    </div>
  );
}
