"use client";

import { createContext, use } from "react";
import { z } from "zod";
import type { RunId, Sha256 } from "@/lib/ids";
import {
  FileRun,
  RunRecord,
  RunRef,
  RunRow,
  RunSuggestion,
  StatusOutcomeWire,
  type NewRunFields,
  type RunFieldsDraft,
  type RunFileRole,
  type RunListFilter,
  type RunStatus,
  type StatusOutcome,
} from "@/lib/run-record";
import { httpDebriefApi, type DebriefApi } from "./api/debrief";
import { httpEvidenceApi, type EvidenceApi } from "./api/evidence";
import { httpFailureApi, type FailureApi } from "./api/failure";
import { getJson, send } from "./api/http";
import { httpSharingApi, type SharingApi } from "./api/sharing";

// What the run record fetches. Its own context, beside LabApi, so the fixture pages can swap
// in canned data. The foundation's methods are here; each slice's are in its own file under
// api/, so four builders can fill theirs in without touching this one.
export type RunsCoreApi = {
  run: (id: RunId, signal: AbortSignal) => Promise<RunRecord>;
  list: (q: { filter: RunListFilter; offset: number }, signal: AbortSignal) => Promise<RunRow[]>;
  // The run each of these files belongs to, for the ones that have one.
  fileRuns: (shas: readonly Sha256[], signal: AbortSignal) => Promise<FileRun[]>;
  suggestions: (signal: AbortSignal) => Promise<RunSuggestion[]>;
  dismissSuggestions: () => Promise<void>;
  retryCandidates: (id: RunId, query: string, signal: AbortSignal) => Promise<RunRef[]>;
  // The writes reject with an Error whose message can be shown.
  create: (shas: readonly Sha256[], fields: NewRunFields) => Promise<RunRecord>;
  edit: (id: RunId, fields: RunFieldsDraft) => Promise<RunRecord>;
  // Resolves { kind: "has_causes" } when the change would remove a written cause; ask, then
  // send it again with clearCauses.
  setStatus: (id: RunId, status: RunStatus | null, clearCauses: boolean) => Promise<StatusOutcome>;
  addFiles: (id: RunId, shas: readonly Sha256[], role: RunFileRole) => Promise<RunRecord>;
  removeFile: (id: RunId, sha256: Sha256) => Promise<RunRecord>;
  linkRetry: (id: RunId, retryOf: RunId | null) => Promise<RunRecord>;
};

export type RunsApi = RunsCoreApi & FailureApi & EvidenceApi & SharingApi & DebriefApi;

// Where one of a run's files opens exactly as Binary read it.
export function runFileHref(id: RunId, sha256: Sha256): string {
  return `/api/run-records/${id}/files/${sha256}`;
}

export function runHref(id: RunId): string {
  return `/runs/${id}`;
}

const base = "/api/run-records";

const httpCoreApi: RunsCoreApi = {
  run: async (id, signal) => RunRecord.parse(await getJson(`${base}/${id}`, {}, signal)),
  list: async ({ filter, offset }, signal) =>
    z.object({ runs: z.array(RunRow) }).parse(await getJson(base, { ...filter, offset: String(offset) }, signal)).runs,
  fileRuns: async (shas, signal) => z.object({ runs: z.array(FileRun) }).parse(await getJson(`${base}/for-files`, { sha256: shas }, signal)).runs,
  suggestions: async (signal) => z.object({ suggestions: z.array(RunSuggestion) }).parse(await getJson(`${base}/suggestions`, {}, signal)).suggestions,
  dismissSuggestions: async () => {
    await send(`${base}/suggestions`, "DELETE", {});
  },
  retryCandidates: async (id, query, signal) => z.object({ runs: z.array(RunRef) }).parse(await getJson(`${base}/${id}/retry`, { q: query }, signal)).runs,
  create: async (shas, fields) => RunRecord.parse(await send(base, "POST", { shas, fields })),
  edit: async (id, fields) => RunRecord.parse(await send(`${base}/${id}`, "POST", fields)),
  setStatus: async (id, status, clearCauses) => StatusOutcomeWire.parse(await send(`${base}/${id}/status`, "POST", { status, clearCauses })),
  addFiles: async (id, shas, role) => RunRecord.parse(await send(`${base}/${id}/files`, "POST", { shas, role })),
  removeFile: async (id, sha256) => RunRecord.parse(await send(`${base}/${id}/files`, "DELETE", { sha256 })),
  linkRetry: async (id, retryOf) => RunRecord.parse(await send(`${base}/${id}/retry`, "POST", { retryOf })),
};

export const httpRunsApi: RunsApi = { ...httpCoreApi, ...httpFailureApi, ...httpEvidenceApi, ...httpSharingApi, ...httpDebriefApi };

const RunsApiContext = createContext<RunsApi>(httpRunsApi);
export const RunsApiProvider = RunsApiContext.Provider;

export function useRunsApi(): RunsApi {
  return use(RunsApiContext);
}
