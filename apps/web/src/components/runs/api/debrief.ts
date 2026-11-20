import { z } from "zod";
import { Debrief, debriefAnswerHeaders, type DebriefQuestion } from "@/lib/debrief";
import type { DebriefId, RunId } from "@/lib/ids";
import { RunRecord, type RunFix } from "@/lib/run-record";
import { answerOf, type SendResult } from "@/lib/upload-queue";
import { localDay, UploadSession } from "@/lib/uploads";
import { failure, getJson, send } from "./http";

// Slice D, the spoken or typed debrief (brief item 5). Every word is the scientist's own; no
// method here asks a model for anything.

export type DebriefApi = {
  // The run's open debrief, else the one last saved to it.
  debrief: (runId: RunId, signal: AbortSignal) => Promise<Debrief | null>;
  startDebrief: (runId: RunId) => Promise<Debrief>;
  // One question's recording; it replaces what that question had.
  recordAnswer: (id: DebriefId, question: DebriefQuestion, audio: { blob: Blob; name: string }) => Promise<Debrief>;
  // A typed answer, or with `correction` the scientist's own reading of a transcript.
  saveAnswerText: (id: DebriefId, question: DebriefQuestion, text: string, correction: boolean) => Promise<Debrief>;
  setFixWorked: (id: DebriefId, fix: RunFix | null) => Promise<Debrief>;
  // Each answer becomes its field on the run; answer 3 becomes the suspected cause only when asked.
  approveDebrief: (id: DebriefId, useAsSuspected: boolean) => Promise<RunRecord>;
  discardDebrief: (id: DebriefId) => Promise<void>;
};

const base = "/api/run-records";
const change = (id: DebriefId) => `${base}/debriefs/${id}`;

async function sha256Hex(blob: Blob): Promise<string | null> {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) return null;
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

// A short clip goes up the way every upload does (components/lab-api.tsx's sendFile): start
// says where, the bytes go there in one PUT, and complete has the server check and record them.
async function sendAnswer(id: DebriefId, question: DebriefQuestion, audio: { blob: Blob; name: string }): Promise<SendResult<Debrief>> {
  const sha256 = await sha256Hex(audio.blob);
  const started = await post("/api/uploads", { purpose: "run-debrief", size: audio.blob.size, type: audio.blob.type });
  const session = answerOf(started.status, started.json, UploadSession);
  if (session.kind !== "stored") return session;
  const put = await fetch(session.receipt.url, { method: "PUT", headers: session.receipt.headers, body: audio.blob }).then(
    (res) => res.status,
    () => 0,
  );
  if (put !== 200) return { kind: "interrupted", message: "The connection dropped." };
  const meta = debriefAnswerHeaders({ debriefId: id, question, name: audio.name, uploadedOn: localDay(new Date()) });
  const done = await post(`/api/uploads/${session.receipt.uploadId}/complete`, { size: audio.blob.size, sha256 }, meta);
  return answerOf(done.status, done.json, Debrief);
}

export const httpDebriefApi: DebriefApi = {
  debrief: async (runId, signal) => z.object({ debrief: Debrief.nullable() }).parse(await getJson(`${base}/${runId}/debrief`, {}, signal)).debrief,
  startDebrief: async (runId) => Debrief.parse(await send(`${base}/${runId}/debrief`, "POST", {})),
  recordAnswer: async (id, question, audio) => {
    const sent = await sendAnswer(id, question, audio);
    if (sent.kind !== "stored") throw failure({ error: sent.message });
    return sent.receipt;
  },
  saveAnswerText: async (id, question, text, correction) => Debrief.parse(await send(change(id), "POST", { action: "text", question, text, correction })),
  setFixWorked: async (id, fix) => Debrief.parse(await send(change(id), "POST", { action: "fix", fix })),
  approveDebrief: async (id, useAsSuspected) => RunRecord.parse(await send(change(id), "POST", { action: "approve", useAsSuspected })),
  discardDebrief: async (id) => {
    await send(change(id), "DELETE", {});
  },
};
