"use client";

import { createContext, use } from "react";
import { z } from "zod";
import { CorrectionWire, FileLabelsWire, SearchResponse, type Correction, type FileLabel, type SearchParams } from "@/lib/domain";
import { correctRequest } from "@/lib/labels";
import type { LabelDraft } from "@/lib/label-edit";
import { SourceStateWire, type SourceState } from "@/lib/source-state";
import type { CorrectionId, Sha256 } from "@/lib/ids";

export type DropboxFolderList = { path: string; folders: { name: string; path: string }[] };

// What client components fetch. The real one talks to our route handlers; the
// dev-only fixture pages swap in canned data through this context.
export type LabApi = {
  search: (params: SearchParams, signal: AbortSignal) => Promise<SearchResponse>;
  sourceState: (signal: AbortSignal) => Promise<SourceState>;
  folders: (path: string, signal: AbortSignal) => Promise<DropboxFolderList>;
  previewUrl: (sha: Sha256, opts: { view: boolean }) => string;
  fileLabels: (shas: readonly Sha256[], signal: AbortSignal) => Promise<FileLabel[]>;
  // Both reject with an Error whose message can be shown to the person.
  correctLabel: (sha: Sha256, draft: LabelDraft) => Promise<Correction>;
  undoCorrection: (id: CorrectionId) => Promise<Correction>;
};

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const ErrorBody = z.object({ error: z.string() });

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ErrorBody.safeParse(json);
    throw new Error(parsed.success ? parsed.data.error : "We couldn't save that. Try again.");
  }
  return json;
}

const FolderList = z.object({
  path: z.string(),
  folders: z.array(z.object({ name: z.string(), path: z.string() })),
});

function searchQuery(params: SearchParams): string {
  const entries = Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "");
  return new URLSearchParams(entries).toString();
}

export const httpLabApi: LabApi = {
  search: async (params, signal) => SearchResponse.parse(await getJson(`/api/search?${searchQuery(params)}`, signal)),
  sourceState: async (signal) => SourceStateWire.parse(await getJson("/api/progress", signal)),
  folders: async (path, signal) =>
    FolderList.parse(await getJson(`/api/dropbox/folders?${new URLSearchParams({ path })}`, signal)),
  previewUrl: (sha, { view }) => `/api/previews/${sha}${view ? "?view=1" : ""}`,
  fileLabels: async (shas, signal) =>
    FileLabelsWire.parse(await getJson(`/api/labels?${new URLSearchParams({ shas: shas.join(",") })}`, signal)),
  correctLabel: async (sha, draft) => CorrectionWire.parse(await postJson("/api/labels/correct", correctRequest(sha, draft))),
  undoCorrection: async (id) => CorrectionWire.parse(await postJson("/api/labels/undo", { correctionId: id })),
};

const LabApiContext = createContext<LabApi>(httpLabApi);
export const LabApiProvider = LabApiContext.Provider;

export function useLabApi(): LabApi {
  return use(LabApiContext);
}
