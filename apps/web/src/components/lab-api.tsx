"use client";

import { createContext, use } from "react";
import { z } from "zod";
import { CorrectionWire, FileLabelsWire, SearchResponse, type Correction, type FileHit, type FileLabel, type SearchParams } from "@/lib/domain";
import { searchQueryString } from "@/lib/filters";
import { correctRequest } from "@/lib/labels";
import type { NoteRequest } from "@/lib/notes";
import type { LabelDraft } from "@/lib/label-edit";
import { BrowseResponse, type FolderPath } from "@/lib/folders";
import { SourceStateWire, type SourceState } from "@/lib/source-state";
import { answerOf, type SendResult, type UploadResult } from "@/lib/upload-queue";
import {
  uploadHeaders,
  UploadReceipt,
  UploadRowsWire,
  UploadSession,
  type UploadMeta,
  type UploadPurpose,
  type UploadRow,
} from "@/lib/uploads";
import type { ChartId, CorrectionId, FlagId, LayoutId, LocationId, ProtocolId, Sha256, TalkThroughId } from "@/lib/ids";
import { LayoutsWire, LayoutWire, type SavedLayout, type SaveLayoutRequest } from "@/lib/layouts";
import type { SaveChecksRequest } from "@/lib/checks";
import { FileChecksWire, FlagAnswerWire, FlagMarksWire, type FileChecks, type FlagAnswer, type ReviewRequest } from "@/lib/flags";
import { TableState } from "@/lib/data-tables";
import { RunChoicesWire, RunInfos, type RunChoices, type RunInfo } from "@/lib/runs";
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
  runs: (shas: readonly Sha256[], signal: AbortSignal) => Promise<RunInfo[]>;
  runChoices: (sha: Sha256, signal: AbortSignal) => Promise<RunChoices>;
  // These reject with an Error whose message can be shown; a stale save resolves as { kind: "stale" }.
  createChart: (req: CreateChartRequest) => Promise<SavedChart>;
  saveChart: (id: ChartId, req: SaveChartRequest) => Promise<ChartSaveOutcome>;
  deleteChart: (id: ChartId) => Promise<void>;
  // Plate layouts saved to use again, newest first. These reject with an Error whose message can be shown.
  layouts: (signal: AbortSignal) => Promise<SavedLayout[]>;
  saveLayout: (req: SaveLayoutRequest) => Promise<SavedLayout>;
  updateLayout: (id: LayoutId, req: SaveLayoutRequest) => Promise<SavedLayout>;
  deleteLayout: (id: LayoutId) => Promise<void>;
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

// The sha256 the server checks the stored file against. Pages off https in dev have no
// crypto.subtle; the server's own hash stands then.
async function sha256Hex(file: Blob): Promise<string | null> {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) return null;
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// XMLHttpRequest, not fetch: only it reports upload progress. R2 answers a good PUT with 200.
function putBytes(url: string, headers: Record<string, string>, bytes: Blob, onProgress: (sent: number) => void, signal: AbortSignal) {
  return new Promise<{ status: number; etag: string | null } | "stopped">((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, etag: xhr.getResponseHeader("etag") });
    xhr.onerror = () => resolve({ status: 0, etag: null });
    xhr.ontimeout = () => resolve({ status: 0, etag: null });
    xhr.onabort = () => resolve("stopped");
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(bytes);
  });
}

const STOPPED = { kind: "interrupted", message: "The upload was stopped." } as const;

// A file goes straight to the store: start says where, the bytes go there in one PUT, and
// complete has the server check them against the size and sha256 sent here and record them.
async function sendFile<R>(
  file: Blob,
  purpose: UploadPurpose,
  meta: Record<string, string>,
  receipt: z.ZodType<R>,
  onProgress: (sent: number) => void,
  signal: AbortSignal,
): Promise<SendResult<R>> {
  const sha256 = await sha256Hex(file);
  const started = await sendForResult("/api/uploads", { purpose, size: file.size, type: file.type }, UploadSession);
  if (started.kind !== "stored") return started;
  if (signal.aborted) return STOPPED;
  const session = started.receipt;
  const put = await putBytes(session.url, session.headers, file, onProgress, signal);
  if (put === "stopped") return STOPPED;
  if (put.status !== 200) {
    return retryable(put.status)
      ? { kind: "interrupted", message: "The connection dropped." }
      : { kind: "refused", message: `The store turned down the file (${put.status}).` };
  }
  return sendForResult(`/api/uploads/${session.uploadId}/complete`, { size: file.size, sha256 }, receipt, meta);
}

// A JSON request read the way the upload queue reads an upload's answer.
async function sendForResult<R>(url: string, body: unknown, schema: z.ZodType<R>, headers: Record<string, string> = {}): Promise<SendResult<R>> {
  try {
    const { status, json } = await sendJson(url, "POST", body, headers);
    return answerOf(status, json, schema);
  } catch {
    return answerOf(0, null, schema);
  }
}

const retryable = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;

function partAnswer(status: number, partNumber: number, etag: string | null): SendResult<UploadedPart> {
  if (status === 200 && etag !== null) return { kind: "stored", receipt: { partNumber, etag } };
  if (status === 200 || retryable(status)) return { kind: "interrupted", message: "The connection dropped." };
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
  if (signal.aborted) return STOPPED;
  const put = await putBytes(target.receipt.url, {}, part.bytes, onProgress, signal);
  return put === "stopped" ? STOPPED : partAnswer(put.status, part.partNumber, put.etag);
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const ErrorBody = z.object({ error: z.string() });

async function sendJson(
  url: string,
  method: "POST" | "DELETE",
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { ...headers, "content-type": "application/json", accept: "application/json" },
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

export const httpLabApi: LabApi = {
  search: async (params, signal) => SearchResponse.parse(await getJson(`/api/search?${searchQueryString(params)}`, signal)),
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
  uploadFile: (file, meta, onProgress, signal) => sendFile(file, "file", uploadHeaders(meta), UploadReceipt, onProgress, signal),
  myUploads: async (signal) => UploadRowsWire.parse(await getJson("/api/uploads", signal)),
  uploadTalkThrough: (file, meta, onProgress, signal) =>
    sendFile(file, "talk-through", talkThroughHeaders(meta), TalkThroughReceipt, onProgress, signal),
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
  runs: async (shas, signal) => RunInfos.parse(await getJson(`/api/runs?${new URLSearchParams(shas.map((s) => ["sha256", s]))}`, signal)),
  runChoices: async (sha, signal) => RunChoicesWire.parse(await getJson(`/api/runs?${new URLSearchParams({ near: sha })}`, signal)),
  createChart: async (req) => ChartWire.parse(await postJson("/api/charts", req)),
  saveChart: async (id, req) => {
    const { status, json } = await sendJson(`/api/charts/${id}`, "POST", req);
    if (status !== 200 && status !== 409) throw failure(json);
    const outcome = ChartSaveOutcomeWire.safeParse(json);
    if (!outcome.success) throw failure(json);
    return outcome.data;
  },
  deleteChart: async (id) => void (await postJson(`/api/charts/${id}`, {}, "DELETE")),
  layouts: async (signal) => LayoutsWire.parse(await getJson("/api/layouts", signal)),
  saveLayout: async (req) => LayoutWire.parse(await postJson("/api/layouts", req)),
  updateLayout: async (id, req) => LayoutWire.parse(await postJson(`/api/layouts/${id}`, req)),
  deleteLayout: async (id) => void (await postJson(`/api/layouts/${id}`, {}, "DELETE")),
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
