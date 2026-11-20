"use client";

import { createContext, use } from "react";
import { z } from "zod";
import type { RunId } from "@/lib/ids";
import { BuildOutcomeWire, Exclusion, RunTask, TaskPreview, type BuildOutcome, type ExclusionKind, type SaveTaskRequest } from "@/lib/task-export";
import { getJson, send } from "../api/http";

// What the task page fetches. Its own context, beside the run record's, so the fixture page
// can swap in canned data.
export type ExportApi = {
  task: (id: RunId, signal: AbortSignal) => Promise<RunTask>;
  // The writes reject with an Error whose message can be shown.
  saveTask: (id: RunId, task: SaveTaskRequest) => Promise<RunTask>;
  // The record as it would leave the lab. Reads only; nothing is built.
  preview: (id: RunId, signal: AbortSignal) => Promise<TaskPreview>;
  // A refusal is an answer, with the reasons.
  build: (id: RunId) => Promise<BuildOutcome>;
  setExclusion: (id: RunId, x: { kind: ExclusionKind; value: string; on: boolean }) => Promise<Exclusion[]>;
};

const at = (id: RunId) => `/api/run-records/${id}/export`;

export const httpExportApi: ExportApi = {
  task: async (id, signal) => RunTask.parse(await getJson(`${at(id)}/task`, {}, signal)),
  saveTask: async (id, task) => RunTask.parse(await send(`${at(id)}/task`, "POST", task)),
  preview: async (id, signal) => TaskPreview.parse(await getJson(`${at(id)}/preview`, {}, signal)),
  build: async (id) => BuildOutcomeWire.parse(await send(`${at(id)}/build`, "POST", {})),
  setExclusion: async (id, x) => z.object({ exclusions: z.array(Exclusion) }).parse(await send(`${at(id)}/exclusions`, "POST", x)).exclusions,
};

const ExportApiContext = createContext<ExportApi>(httpExportApi);
export const ExportApiProvider = ExportApiContext.Provider;

export function useExportApi(): ExportApi {
  return use(ExportApiContext);
}
