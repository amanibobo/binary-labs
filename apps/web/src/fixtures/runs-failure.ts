import { httpFailureApi, type FailureApi } from "@/components/runs/api/failure";
import type { FixtureRunStore } from "./runs";

// Slice A's fixture twin: its methods over the page's own copy of the runs. Not built yet, so
// it answers as the real one does until then.
export const fixtureFailureApi: (store: FixtureRunStore) => FailureApi = () => httpFailureApi;
