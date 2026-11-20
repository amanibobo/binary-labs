"use client";

import { useState, type ReactNode } from "react";
import type { Debrief } from "@/lib/debrief";
import { seedFixtureDebrief } from "./runs-debrief";

// Puts a fixture page's debrief in place before the fixture API under it is made.
export function SeedDebrief({ debrief, children }: { debrief: Debrief | null; children: ReactNode }) {
  useState(() => {
    if (debrief !== null) seedFixtureDebrief(debrief);
  });
  return children;
}
