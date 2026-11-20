import { httpEvidenceApi, type EvidenceApi } from "@/components/runs/api/evidence";
import type { FixtureRunStore } from "./runs";

// Slice B's fixture twin: its methods over the page's own copy of the runs. Not built yet, so
// it answers as the real one does until then.
export function fixtureEvidenceApi(_store: FixtureRunStore): EvidenceApi {
  return httpEvidenceApi;
}
