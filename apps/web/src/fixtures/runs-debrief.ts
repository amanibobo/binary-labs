import { httpDebriefApi, type DebriefApi } from "@/components/runs/api/debrief";
import type { FixtureRunStore } from "./runs";

// Slice D's fixture twin: its methods over the page's own copy of the runs. Not built yet, so
// it answers as the real one does until then.
export function fixtureDebriefApi(_store: FixtureRunStore): DebriefApi {
  return httpDebriefApi;
}
