"use client";

import { createContext, use } from "react";
import { z } from "zod";
import { CorrectionWire, FileLabelsWire, SearchResponse, type Correction, type FileHit, type FileLabel, type SearchParams } from "@/lib/domain";
import { correctRequest } from "@/lib/labels";
import type { NoteRequest } from "@/lib/notes";
import type { LabelDraft } from "@/lib/label-edit";
import { BrowseResponse, type FolderPath } from "@/lib/folders";
import { SourceStateWire, type SourceState } from "@/lib/source-state";
import { answerOf, resultOf, type SendResult, type UploadResult } from "@/lib/upload-queue";
import { uploadHeaders, UploadRowsWire, type UploadMeta, type UploadRow } from "@/lib/uploads";
import type { ChartId, CorrectionId, FlagId, LocationId, ProtocolId, Sha256, TalkThroughId } from "@/lib/ids";
import type { SaveChecksRequest } from "@/lib/checks";
import { FileChecksWire, FlagAnswerWire, FlagMarksWire, type FileChecks, type FlagAnswer, type ReviewRequest } from "@/lib/flags";
import { TableState } from "@/lib/data-tables";
import { HubFiles, LocalView, type HubQuery, type LocalQuery } from "@/lib/map";
import {
  ChartSaveOutcomeWire,
  ChartsWire,
  ChartWire,
  type ChartSaveOutcome,
  type CreateChartRequest,
  type SaveChartRequest,
  type SavedChart,
} from "@/lib/charts";
import {
  PartTarget,
  ProtocolVideosWire,
  VideoReceipt,
  VideoSession,
  type CompleteVideoRequest,
  playbackUrl,
  type ProtocolVideo,
  type ReadyVideo,
  type StartVideoRequest,
} from "@/lib/videos";
import type { UploadedPart } from "@/lib/parts";
import {
  talkThroughHeaders,
  TalkThroughReceipt,
  TalkThroughWire,
  VideoSteps,
  type TalkThrough,
  type TalkThroughMeta,
  type ApplyTalkThroughRequest,
} from "@/lib/talk-throughs";
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
  // Keeps, splits (or un-splits), takes a page out of, or joins a note; rejects with a showable Error.
  changeNote: (req: NoteRequest) => Promise<void>;
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
  // Never rejects, like uploadFile.
  uploadTalkThrough: (
    file: Blob,
    meta: TalkThroughMeta,
    onProgress: (sent: number) => void,
    signal: AbortSignal,
  ) => Promise<SendResult<TalkThroughReceipt>>;
  talkThrough: (id: TalkThroughId, signal: AbortSignal) => Promise<TalkThrough>;
  // These reject with an Error whose message can be shown; a stale save resolves as { kind: "stale" }.
  retryTalkThrough: (id: TalkThroughId) => Promise<void>;
  applyTalkThrough: (id: TalkThroughId, req: ApplyTalkThroughRequest) => Promise<SaveOutcome>;
  dismissTalkThrough: (id: TalkThroughId) => Promise<void>;
  // Where a talk-through's recording or video plays from.
  mediaUrl: (locationId: LocationId) => string;
  // Starts drafting steps from a video on the page, or finds the draft already open for it.
  draftStepsFromVideo: (protocolId: ProtocolId, sha: Sha256) => Promise<TalkThroughId>;
  // A video goes up in parts; none of these three rejects, like uploadFile.
  startVideoUpload: (req: StartVideoRequest) => Promise<SendResult<VideoSession>>;
  sendVideoPart: (
    session: VideoSession,
    part: { partNumber: number; bytes: Blob; fileSize: number },
    onProgress: (sent: number) => void,
    signal: AbortSignal,
  ) => Promise<SendResult<UploadedPart>>;
  completeVideoUpload: (session: VideoSession, req: Omit<CompleteVideoRequest, "storeId">) => Promise<SendResult<VideoReceipt>>;
  abortVideoUpload: (session: VideoSession) => Promise<void>;
  protocolVideos: (id: ProtocolId, signal: AbortSignal) => Promise<ProtocolVideo[]>;
  videoSources: (video: ReadyVideo) => { src: string; poster: string | null };
  // These reject with an Error whose message can be shown.
  retryVideoTranscript: (sha: Sha256) => Promise<void>;
  removePendingVideo: (id: ProtocolId, locationId: LocationId) => Promise<void>;
  // A file's parsed tables, or how far the worker has got with them.
  dataTable: (sha: Sha256, signal: AbortSignal) => Promise<TableState>;
  requestDataTable: (sha: Sha256) => Promise<void>;
  fileCharts: (sha: Sha256, signal: AbortSignal) => Promise<SavedChart[]>;
  // These reject with an Error whose message can be shown; a stale save resolves as { kind: "stale" }.
  createChart: (req: CreateChartRequest) => Promise<SavedChart>;
  saveChart: (id: ChartId, req: SaveChartRequest) => Promise<ChartSaveOutcome>;
  deleteChart: (id: ChartId) => Promise<void>;
  // The lab map: one hub's files, and the map around one node.
  mapHub: (q: HubQuery, signal: AbortSignal) => Promise<HubFiles>;
  mapLocal: (q: LocalQuery, signal: AbortSignal) => Promise<LocalView>;
  // A file's checks and open flags; open flags per file for rows on screen.
  fileChecks: (sha: Sha256, signal: AbortSignal) => Promise<FileChecks>;
  flagMarks: (shas: readonly Sha256[], signal: AbortSignal) => Promise<Record<string, number>>;
  // These reject with an Error whose message can be shown; a stale save resolves as { kind: "stale" }.
  reviewFlag: (id: FlagId, req: ReviewRequest) => Promise<FlagAnswer>;
  saveChecks: (id: ProtocolId, req: SaveChecksRequest) => Promise<SaveOutcome>;
};

// XMLHttpRequest, not fetch: only it reports upload progress.
function sendFile<R>(
  file: Blob,
  headers: Record<string, string>,
  read: (status: number, body: unknown) => SendResult<R>,
  onProgress: (sent: number) => void,
  signal: AbortSignal,
): Promise<SendResult<R>> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.responseType = "json";
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve(read(xhr.status, xhr.response));
    xhr.onerror = () => resolve(read(0, null));
    xhr.ontimeout = () => resolve(read(0, null));
    xhr.onabort = () => resolve({ kind: "interrupted", message: "The upload was stopped." });
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

// A JSON request read the way the upload queue reads an upload's answer.
async function sendForResult<R>(url: string, body: unknown, schema: z.ZodType<R>): Promise<SendResult<R>> {
  try {
    const { status, json } = await sendJson(url, "POST", body);
    return answerOf(status, json, schema);
  } catch {
    return answerOf(0, null, schema);
  }
}

function partAnswer(status: number, partNumber: number, etag: string | null): SendResult<UploadedPart> {
  if (status === 200 && etag !== null) return { kind: "stored", receipt: { partNumber, etag } };
  if (status === 0 || status === 200 || status === 408 || status === 429 || status >= 500) {
    return { kind: "interrupted", message: "The connection dropped." };
  }
  return { kind: "refused", message: `The store turned down part of the video (${status}).` };
}

// One part of a video: where it goes comes from us, then the bytes go there. The store's ETag
// for the part comes back in a response header (R2's bucket CORS rule must expose it).
async function sendPart(
  session: VideoSession,
  part: { partNumber: number; bytes: Blob; fileSize: number },
  onProgress: (sent: number) => void,
  signal: AbortSignal,
): Promise<SendResult<UploadedPart>> {
  const target = await sendForResult(
    `/api/videos/uploads/${session.uploadId}/parts/${part.partNumber}`,
    { storeId: session.storeId, size: part.fileSize },
    PartTarget,
  );
  if (target.kind !== "stored") return target;
  if (signal.aborted) return { kind: "interrupted", message: "The upload was stopped." };
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target.receipt.url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve(partAnswer(xhr.status, part.partNumber, xhr.getResponseHeader("etag")));
    xhr.onerror = () => resolve(partAnswer(0, part.partNumber, null));
    xhr.ontimeout = () => resolve(partAnswer(0, part.partNumber, null));
    xhr.onabort = () => resolve({ kind: "interrupted", message: "The upload was stopped." });
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(part.bytes);
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
  changeNote: async (req) => {
    await postJson("/api/notes", req);
  },
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
  uploadFile: (file, meta, onProgress, signal) => sendFile(file, uploadHeaders(meta), resultOf, onProgress, signal),
  myUploads: async (signal) => UploadRowsWire.parse(await getJson("/api/uploads", signal)),
  uploadTalkThrough: (file, meta, onProgress, signal) =>
    sendFile(file, talkThroughHeaders(meta), (status, body) => answerOf(status, body, TalkThroughReceipt), onProgress, signal),
  talkThrough: async (id, signal) => TalkThroughWire.parse(await getJson(`/api/talk-throughs/${id}`, signal)),
  retryTalkThrough: async (id) => void (await postJson(`/api/talk-throughs/${id}/retry`, {})),
  applyTalkThrough: async (id, req) => {
    const { status, json } = await sendJson(`/api/talk-throughs/${id}/use`, "POST", req);
    if (status !== 200 && status !== 409) throw failure(json);
    const outcome = SaveOutcomeWire.safeParse(json);
    if (!outcome.success) throw failure(json);
    return outcome.data;
  },
  dismissTalkThrough: async (id) => void (await postJson(`/api/talk-throughs/${id}/dismiss`, {})),
  mediaUrl: (locationId) => `/api/files/${locationId}`,
  draftStepsFromVideo: async (protocolId, sha) => VideoSteps.parse(await postJson(`/api/protocols/${protocolId}/videos/${sha}/steps`, {})).talkThroughId,
  startVideoUpload: (req) => sendForResult("/api/videos/uploads", req, VideoSession),
  sendVideoPart: sendPart,
  completeVideoUpload: (session, req) =>
    sendForResult(`/api/videos/uploads/${session.uploadId}/complete`, { ...req, storeId: session.storeId }, VideoReceipt),
  abortVideoUpload: async (session) => {
    await sendJson(`/api/videos/uploads/${session.uploadId}`, "DELETE", { storeId: session.storeId }).catch(() => undefined);
  },
  protocolVideos: async (id, signal) => ProtocolVideosWire.parse(await getJson(`/api/protocols/${id}/videos`, signal)),
  videoSources: (video) => ({ src: playbackUrl(video), poster: video.hasPoster ? `/api/previews/${video.sha256}` : null }),
  retryVideoTranscript: async (sha) => void (await postJson(`/api/videos/${sha}/retry`, {})),
  removePendingVideo: async (id, locationId) => void (await postJson(`/api/protocols/${id}/videos`, { locationId }, "DELETE")),
  dataTable: async (sha, signal) => TableState.parse(await getJson(`/api/tables/${sha}`, signal)),
  requestDataTable: async (sha) => void (await postJson(`/api/tables/${sha}`, {})),
  fileCharts: async (sha, signal) => ChartsWire.parse(await getJson(`/api/charts?${new URLSearchParams({ sha256: sha })}`, signal)),
  createChart: async (req) => ChartWire.parse(await postJson("/api/charts", req)),
  saveChart: async (id, req) => {
    const { status, json } = await sendJson(`/api/charts/${id}`, "POST", req);
    if (status !== 200 && status !== 409) throw failure(json);
    const outcome = ChartSaveOutcomeWire.safeParse(json);
    if (!outcome.success) throw failure(json);
    return outcome.data;
  },
  deleteChart: async (id) => void (await postJson(`/api/charts/${id}`, {}, "DELETE")),
  mapHub: async (q, signal) => {
    const params = new URLSearchParams({ id: q.id });
    if (q.similar) params.set("similar", "1");
    for (const hub of q.with) params.append("with", hub);
    return HubFiles.parse(await getJson(`/api/map/hub?${params}`, signal));
  },
  mapLocal: async (q, signal) => {
    const params = new URLSearchParams({ around: q.around, depth: String(q.depth) });
    if (q.similar) params.set("similar", "1");
    return LocalView.parse(await getJson(`/api/map/local?${params}`, signal));
  },
  fileChecks: async (sha, signal) => FileChecksWire.parse(await getJson(`/api/flags?${new URLSearchParams({ sha256: sha })}`, signal)),
  flagMarks: async (shas, signal) =>
    FlagMarksWire.parse(await getJson(`/api/flags/marks?${new URLSearchParams({ shas: shas.join(",") })}`, signal)),
  reviewFlag: async (id, req) => FlagAnswerWire.parse(await postJson(`/api/flags/${id}`, req)),
  saveChecks: async (id, req) => {
    const { status, json } = await sendJson(`/api/protocols/${id}/checks`, "POST", req);
    if (status !== 200 && status !== 409) throw failure(json);
    const outcome = SaveOutcomeWire.safeParse(json);
    if (!outcome.success) throw failure(json);
    return outcome.data;
  },
};

const LabApiContext = createContext<LabApi>(httpLabApi);
export const LabApiProvider = LabApiContext.Provider;

export function useLabApi(): LabApi {
  return use(LabApiContext);
}
