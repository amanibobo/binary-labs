import { z } from "zod";
import { PlanBodies, PlanChoice } from "@/lib/as-run";
import type { ProtocolVersionId, RunId } from "@/lib/ids";
import { RunRecord } from "@/lib/run-record";
import { EditedFile } from "@/lib/run-originals";
import { getJson, send } from "./http";

// Slice B: the run's files edited since, and planned versus actual (brief items 2 and 3).

export type EvidenceApi = {
  // The run's files whose place in the lab's folder holds a later version now.
  editedFiles: (id: RunId, signal: AbortSignal) => Promise<EditedFile[]>;
  planBodies: (id: RunId, signal: AbortSignal) => Promise<PlanBodies>;
  planChoices: (id: RunId, query: string, signal: AbortSignal) => Promise<PlanChoice[]>;
  setPlan: (id: RunId, versionId: ProtocolVersionId | null) => Promise<RunRecord>;
  // An empty body clears what was written.
  saveAsRun: (id: RunId, input: { body: string; basedOn: ProtocolVersionId | null }) => Promise<RunRecord>;
};

const base = (id: RunId) => `/api/run-records/${id}`;

export const httpEvidenceApi: EvidenceApi = {
  editedFiles: async (id, signal) => z.object({ files: z.array(EditedFile) }).parse(await getJson(`${base(id)}/originals`, {}, signal)).files,
  planBodies: async (id, signal) => PlanBodies.parse(await getJson(`${base(id)}/plan`, {}, signal)),
  planChoices: async (id, query, signal) => z.object({ choices: z.array(PlanChoice) }).parse(await getJson(`${base(id)}/plan/choices`, { q: query }, signal)).choices,
  setPlan: async (id, versionId) => RunRecord.parse(await send(`${base(id)}/plan`, "POST", { versionId })),
  saveAsRun: async (id, input) => RunRecord.parse(await send(`${base(id)}/plan/as-run`, "POST", input)),
};
