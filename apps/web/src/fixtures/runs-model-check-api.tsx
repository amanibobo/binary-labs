"use client";

import { useState, type ReactNode } from "react";
import { ModelCheckApiProvider } from "@/components/runs/model-check/api";
import { createFixtureModelCheck, type ModelCheckView } from "./runs-model-check";

// The model check's API for its fixture page: canned data, writes kept in the page.
export function FixtureModelCheck({ view, children }: { view: ModelCheckView; children: ReactNode }) {
  const [api] = useState(() => createFixtureModelCheck(view));
  return <ModelCheckApiProvider value={api}>{children}</ModelCheckApiProvider>;
}
