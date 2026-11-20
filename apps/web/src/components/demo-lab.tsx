"use client";

import { createContext, use, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { SAMPLE_NOTE } from "@/lib/sample";

const DemoLab = createContext(false);

export function DemoLabProvider({ demo, children }: { demo: boolean; children: ReactNode }) {
  return <DemoLab value={demo}>{children}</DemoLab>;
}

export function useDemoLab(): boolean {
  return use(DemoLab);
}

export function SampleTag({ className }: { className?: string }) {
  return (
    <span title={SAMPLE_NOTE} className={cn("shrink-0 rounded-md border border-border-raised px-1.5 text-label-xsmall text-content-secondary", className)}>
      Sample
    </span>
  );
}
