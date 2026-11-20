"use client";

import { useState, type ReactNode } from "react";
import { RunsApiProvider } from "@/components/runs/runs-api";
import { createFixtureRuns } from "./runs";

// The run record's API for the fixture pages: canned data, writes kept in the page.
export function FixtureRuns({ children }: { children: ReactNode }) {
  const [api] = useState(createFixtureRuns);
  return <RunsApiProvider value={api}>{children}</RunsApiProvider>;
}
