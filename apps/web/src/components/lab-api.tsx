"use client";

import { createContext, use } from "react";
import { z } from "zod";
import { CorrectionWire, FileLabelsWire, SearchResponse, type Correction, type FileHit, type FileLabel, type SearchParams } from "@/lib/domain";
import { correctRequest } from "@/lib/labels";
import type { LabelDraft } from "@/lib/label-edit";
import { BrowseResponse, type FolderPath } from "@/lib/folders";
import { SourceStateWire, type SourceState } from "@/lib/source-state";
import { resultOf, type UploadResult } from "@/lib/upload-queue";
import { uploadHeaders, UploadRowsWire, type UploadMeta, type UploadRow } from "@/lib/uploads";
import type { CorrectionId, ProtocolId, Sha256 } from "@/lib/ids";
import {
  ProtocolVersionWire,
  SavedVersionWire,
  SaveOutcomeWire,
  type CreateProtocolRequest,
  type ProtocolVersion,
  type SavedVersion,
  type SaveOutcome,
  type SaveProtocolRequest,
} from "@/lib/protocols";

export type DropboxFolderList = { path: string; folders: { name: string; path: string }[] };

// What client components fetch. The real one talks to our route handlers; the
// dev-only fixture pages swap in canned data through this context.
export type LabApi = {
  search: (params: SearchParams, signal: AbortSignal) => Promise<SearchResponse>;
  sourceState: (signal: AbortSignal) => Promise<SourceState>;
  folders: (path: string, signal: AbortSignal) => Promise<DropboxFolderList>;
  folderFiles: (path: FolderPath, offset: number, signal: AbortSignal) => Promise<FileHit[]>;
  previewUrl: (sha: Sha256, opts: { view: boolean }) => string;
  fileLabels: (shas: readonly Sha256[], signal: AbortSignal) => Promise<FileLabel[]>;
  // Both reject with an Error whose message can be shown to the person.
  correctLabel: (sha: Sha256, draft: LabelDraft) => Promise<Correction>;
  undoCorrection: (id: CorrectionId) => Promise<Correction>;
  // The page's current version, to start over from after someone else saved.
  protocol: (id: ProtocolId, signal: AbortSignal) => Promise<ProtocolVersion>;
  // These reject with an Error whose message can be shown; a stale save resolves as { kind: "stale" }.
  createProtocol: (req: CreateProtocolRequest) => Promise<SavedVersion>;
  saveProtocol: (id: ProtocolId, req: SaveProtocolRequest) => Promise<SaveOutcome>;
  archiveProtocol: (id: ProtocolId) => Promise<void>;
  linkProtocolFile: (id: ProtocolId, sha: Sha256) => Promise<void>;
  unlinkProtocolFile: (id: ProtocolId, sha: Sha256) => Promise<void>;
  // Never rejects: a failed upload comes back as a result the queue knows how to retry.
  uploadFile: (file: Blob, meta: UploadMeta, onProgress: (sent: number) => void, signal: AbortSignal) => Promise<UploadResult>;
  myUploads: (signal: AbortSignal) => Promise<UploadRow[]>;
};

// XMLHttpRequest, not fetch: only it reports upload progress.
function sendFile(file: Blob, meta: UploadMeta, onProgress: (sent: number) => void, signal: AbortSignal): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.responseType = "json";
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    for (const [name, value] of Object.entries(uploadHeaders(meta))) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve(resultOf(xhr.status, xhr.response));
    xhr.onerror = () => resolve(resultOf(0, null));
    xhr.ontimeout = () => resolve(resultOf(0, null));
    xhr.onabort = () => resolve({ kind: "interrupted", message: "The upload was stopped." });
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const ErrorBody = z.object({ error: z.string() });

async function sendJson(url: string, method: "POST" | "DELETE", body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function failure(json: unknown): Error {
  const parsed = ErrorBody.safeParse(json);
  return new Error(parsed.success ? parsed.data.error : "We couldn't save that. Try again.");
}

async function postJson(url: string, body: unknown, method: "POST" | "DELETE" = "POST"): Promise<unknown> {
  const { status, json } = await sendJson(url, method, body);
  if (status < 200 || status >= 300) throw failure(json);
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
  folderFiles: async (path, offset, signal) =>
    BrowseResponse.parse(await getJson(`/api/browse?${new URLSearchParams({ path, offset: String(offset) })}`, signal))
      .files,
  previewUrl: (sha, { view }) => `/api/previews/${sha}${view ? "?view=1" : ""}`,
  fileLabels: async (shas, signal) =>
    FileLabelsWire.parse(await getJson(`/api/labels?${new URLSearchParams({ shas: shas.join(",") })}`, signal)),
  correctLabel: async (sha, draft) => CorrectionWire.parse(await postJson("/api/labels/correct", correctRequest(sha, draft))),
  undoCorrection: async (id) => CorrectionWire.parse(await postJson("/api/labels/undo", { correctionId: id })),
  protocol: async (id, signal) => ProtocolVersionWire.parse(await getJson(`/api/protocols/${id}`, signal)),
  createProtocol: async (req) => SavedVersionWire.parse(await postJson("/api/protocols", req)),
  saveProtocol: async (id, req) => {
    const { status, json } = await sendJson(`/api/protocols/${id}`, "POST", req);
    if (status !== 200 && status !== 409) throw failure(json);
    const outcome = SaveOutcomeWire.safeParse(json);
    if (!outcome.success) throw failure(json);
    return outcome.data;
  },
  archiveProtocol: async (id) => void (await postJson(`/api/protocols/${id}/archive`, {})),
  linkProtocolFile: async (id, sha) => void (await postJson(`/api/protocols/${id}/files`, { sha256: sha })),
  unlinkProtocolFile: async (id, sha) => void (await postJson(`/api/protocols/${id}/files`, { sha256: sha }, "DELETE")),
  uploadFile: sendFile,
  myUploads: async (signal) => UploadRowsWire.parse(await getJson("/api/uploads", signal)),
};

const LabApiContext = createContext<LabApi>(httpLabApi);
export const LabApiProvider = LabApiContext.Provider;

export function useLabApi(): LabApi {
  return use(LabApiContext);
}
