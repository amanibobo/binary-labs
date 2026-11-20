"use client";

import { useEffect, useState } from "react";
import { RunView } from "@/components/runs/run-page";
import { useRunsApi, type RunsApi } from "@/components/runs/runs-api";
import { RunsListView } from "@/components/runs/runs-list";
import type { PersonId } from "@/lib/ids";
import type { RunListFilter, RunRecord, RunRow } from "@/lib/run-record";
import { people } from "./data";
import { FIRST_TRY, RETRY } from "./runs";
import { resetFixtureLinks, setFixtureViewer } from "./runs-failure";

// The failure record's fixture views, written through the fixture API so every later write
// finds them: Ade types in the first try's confirmed cause naming Priya, and then the page is
// Priya's, who hasn't said yes yet. In "unlinked" Ade names Jordan, whose People row has no
// account, and the page is Jordan's own account, which isn't anyone in People yet.

type View = "yours" | "unlinked" | "list";
const priya = people[1]?.id;
const jordan = people[2]?.id;

// Once per page's API: development renders run an effect twice, and two seeds at once would
// hand the page back to Priya before the second confirmation, making it her own yes.
const seeded = new WeakMap<RunsApi, Promise<RunRecord>>();
function seedOnce(api: RunsApi, view: View): Promise<RunRecord> {
  const known = seeded.get(api);
  if (known !== undefined) return known;
  const made = seed(api, view === "unlinked" ? jordan : priya).finally(() => setFixtureViewer(view === "unlinked" ? 2 : 1));
  seeded.set(api, made);
  return made;
}

async function seed(api: RunsApi, confirmer: PersonId | undefined): Promise<RunRecord> {
  if (confirmer === undefined) throw new Error("the failure fixture needs Priya and Jordan");
  resetFixtureLinks();
  setFixtureViewer(0);
  try {
    await api.setSuspectedCause(FIRST_TRY, "Induced at 37 °C, so the protein may have come out insoluble.");
    await api.setFailureType(FIRST_TRY, { version: 1, technique: "tech.protein_prep", failedStep: "step.run", causeCategory: "cause.conditions" });
    return await api.confirmCause(FIRST_TRY, {
      cause: "Inducing at 37 °C made the protein insoluble. Induced at 18 °C, it came out soluble.",
      personId: confirmer,
      evidence: { method: "repeat", runId: RETRY },
      note: null,
      confirmedAt: "2026-11-04T12:00:00.000Z",
    });
  } finally {
    setFixtureViewer(1);
  }
}

function matches(row: RunRow, filter: RunListFilter): boolean {
  return (
    (filter.status === undefined || (filter.status === "none" ? row.status === null : row.status === filter.status)) &&
    (filter.technique === undefined || row.technique === filter.technique) &&
    (filter.step === undefined || row.failedStep === filter.step) &&
    (filter.cause === undefined || row.causeCategory === filter.cause)
  );
}

export function FailureFixtureView({ view, filter }: { view: View; filter: RunListFilter }) {
  const api = useRunsApi();
  const [shown, setShown] = useState<{ kind: "run"; run: RunRecord } | { kind: "list"; rows: RunRow[] } | null>(null);
  useEffect(() => {
    let live = true;
    void seedOnce(api, view).then(async (run) => {
      const next = view !== "list" ? { kind: "run" as const, run } : { kind: "list" as const, rows: (await api.list({ filter: {}, offset: 0 }, new AbortController().signal)).filter((r) => matches(r, filter)) };
      if (live) setShown(next);
    });
    return () => {
      live = false;
    };
  }, [api, view, filter]);
  if (shown === null) return null;
  return shown.kind === "run" ? <RunView initial={shown.run} /> : <RunsListView initial={shown.rows} suggestions={[]} filter={filter} />;
}
