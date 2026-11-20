import { httpSharingApi, type SharingApi } from "@/components/runs/api/sharing";
import type { FixtureRunStore } from "./runs";

// Slice C's fixture twin: its methods over the page's own copy of the runs. Not built yet, so
// it answers as the real one does until then.
export function fixtureSharingApi(_store: FixtureRunStore): SharingApi {
  return httpSharingApi;
}
