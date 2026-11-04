"use client";

import { useState, type ReactNode } from "react";
import { LabApiProvider, type LabApi } from "@/components/lab-api";
import type { FileHit } from "@/lib/domain";
import type { SourceState } from "@/lib/source-state";
import { folderFixtureFiles, folders, laterLabels, needsLookFiles, recentFiles, searchHits } from "./data";
import { createFixtureLabels } from "./fixture-labels";
import { PREVIEW_BY_FIRST_CHAR } from "./previews";

export type FixtureSearchMode = "hybrid" | "keyword";

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
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
  const [labels] = useState(() =>
    createFixtureLabels({ initial: [...searchHits, ...recentFiles, ...needsLookFiles], later: laterLabels }),
  );
  const withLabels = (hits: FileHit[]) => hits.map((h) => ({ ...h, label: labels.get(h.sha256) }));
  const api: LabApi = {
    search: async (_params, signal) => {
      await wait(120, signal);
      return mode === "hybrid"
        ? { kind: "hybrid", results: withLabels(searchHits) }
        : { kind: "keyword", reason: "embed_timeout", results: withLabels(keywordOnly(searchHits)) };
    },
    sourceState: async () => source,
    folders: async (path, signal) => {
      await wait(150, signal);
      return { path, folders: folders[path] ?? [] };
    },
    folderFiles: async (path, offset, signal) => {
      await wait(150, signal);
      return folderFixtureFiles(path, offset);
    },
    previewUrl: (sha) => PREVIEW_BY_FIRST_CHAR[sha.charAt(0)] ?? "",
    fileLabels: async (shas, signal) => {
      await wait(80, signal);
      return labels.poll(shas);
    },
    correctLabel: async (sha, draft) => {
      await wait(150);
      return labels.correct(sha, draft);
    },
    undoCorrection: async (id) => {
      await wait(150);
      return labels.undo(id);
    },
  };
  return <LabApiProvider value={api}>{children}</LabApiProvider>;
}
