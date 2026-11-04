"use client";

import type { ReactNode } from "react";
import { LabApiProvider, type LabApi } from "@/components/lab-api";
import type { FileHit } from "@/lib/domain";
import type { SourceState } from "@/lib/source-state";
import { folders, searchHits } from "./data";
import { PREVIEW_BY_FIRST_CHAR } from "./previews";

export type FixtureSearchMode = "hybrid" | "keyword";

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      reject(signal.reason);
    });
  });

function keywordOnly(hits: FileHit[]): FileHit[] {
  return hits.filter((h) => h.matchedBy.includes("words")).map((h) => ({ ...h, matchedBy: ["words"] }));
}

export function FixtureLabApi({
  mode,
  source,
  children,
}: {
  mode: FixtureSearchMode;
  source: SourceState;
  children: ReactNode;
}) {
  const api: LabApi = {
    search: async (_params, signal) => {
      await wait(120, signal);
      return mode === "hybrid"
        ? { kind: "hybrid", results: searchHits }
        : { kind: "keyword", reason: "embed_timeout", results: keywordOnly(searchHits) };
    },
    sourceState: async () => source,
    folders: async (path, signal) => {
      await wait(150, signal);
      return { path, folders: folders[path] ?? [] };
    },
    previewUrl: (sha) => PREVIEW_BY_FIRST_CHAR[sha.charAt(0)] ?? "",
  };
  return <LabApiProvider value={api}>{children}</LabApiProvider>;
}
