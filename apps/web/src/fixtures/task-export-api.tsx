"use client";

import { useState, type ReactNode } from "react";
import { ExportApiProvider } from "@/components/runs/export/export-api";
import { createFixtureExport, type TaskFixtureView } from "./task-export";

// The task page's API for its fixture page: canned data, writes kept in the page.
export function FixtureExport({ view, children }: { view: TaskFixtureView; children: ReactNode }) {
  const [api] = useState(() => createFixtureExport(view));
  return <ExportApiProvider value={api}>{children}</ExportApiProvider>;
}
