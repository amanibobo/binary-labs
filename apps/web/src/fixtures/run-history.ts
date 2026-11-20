import { FlagId, LocationId, Sha256 } from "@/lib/ids";
import { bradfordAssay, bradfordChecks, BLANKS, CURVE } from "./flags";
import type { HistoryRun, RunHistory } from "@/lib/run-history";

// Dev-only: a Bradford protocol's standard-curve check across ten runs (decisions.md, "charts
// round 2"). Run 4 was flagged (the 750 standard pipetted short), run 7 is labeled failed and
// still passed, run 8 couldn't be checked, and version 3 tightened the range from 0.95 to 0.98.

const run = (n: number, observed: number | null, extra: Partial<HistoryRun> = {}): HistoryRun => ({
  run: {
    sha256: Sha256.parse(n.toString(16).padStart(2, "0").repeat(32)),
    locationId: LocationId.parse(`6c1c2c39-5a4e-4c55-9d7b-0c3c1a7b${String(n).padStart(4, "0")}`),
    name: `Bradford_2026-10-${String(10 + n * 2).padStart(2, "0")}.xlsx`,
    date: `2026-10-${String(10 + n * 2).padStart(2, "0")}`,
    outcome: "worked",
    experiment: "P450 purification",
  },
  observed,
  result: observed === null ? "couldnt" : "passed",
  reason: observed === null ? "Fewer than three standards had a reading." : null,
  range: n < 5 ? { kind: "at_least", min: 0.95 } : { kind: "at_least", min: 0.98 },
  unit: null,
  version: n < 5 ? 2 : 3,
  flagId: null,
  ...extra,
});

const [curveCheck] = bradfordChecks;
if (curveCheck === undefined) throw new Error("the flags fixture has no curve check");

export const fixtureHistory: RunHistory = {
  protocol: { id: bradfordAssay.protocolId, title: bradfordAssay.title },
  check: curveCheck,
  checks: [
    { id: CURVE, name: "Standard curve fit" },
    { id: BLANKS, name: "Blanks" },
  ],
  runs: [
    run(1, 0.991),
    run(2, 0.987),
    run(3, 0.993),
    run(4, 0.884, { result: "flagged", flagId: FlagId.parse("9f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0004") }),
    run(5, 0.996),
    run(6, 0.989),
    run(7, 0.982, { run: { ...run(7, null).run, outcome: "failed" } }),
    run(8, null),
    run(9, 0.994),
    run(10, 0.998),
  ],
};
