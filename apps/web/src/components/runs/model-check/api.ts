"use client";

import { createContext, use } from "react";
import type { RunId } from "@/lib/ids";
import { RunModelChecks, type ModelCheckRequest } from "@/lib/model-check";
import { getJson, send } from "../api/http";

// What the model check fetches. Its own context, so the fixture page can swap in canned data
// without touching the run record's API.
export type ModelCheckApi = {
  load: (runId: RunId, signal: AbortSignal) => Promise<RunModelChecks>;
  // Rejects with an Error whose message can be shown.
  send: (runId: RunId, request: ModelCheckRequest) => Promise<RunModelChecks>;
};

const path = (runId: RunId) => `/api/run-records/${runId}/model-check`;

export const httpModelCheckApi: ModelCheckApi = {
  load: async (runId, signal) => RunModelChecks.parse(await getJson(path(runId), {}, signal)),
  send: async (runId, request) => RunModelChecks.parse(await send(path(runId), "POST", request)),
};

const ModelCheckApiContext = createContext<ModelCheckApi>(httpModelCheckApi);
export const ModelCheckApiProvider = ModelCheckApiContext.Provider;

export function useModelCheckApi(): ModelCheckApi {
  return use(ModelCheckApiContext);
}

export function modelCheckHref(runId: RunId): string {
  return `/runs/${runId}/model-check`;
}
