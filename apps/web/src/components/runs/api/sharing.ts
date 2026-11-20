import type { RunId, UserId } from "@/lib/ids";
import type { RunRecord } from "@/lib/run-record";
import { notBuilt } from "./http";

// Slice C, sharing and the export gate (brief item 4). The foundation typed this interface
// and left the bodies; the slice fills them in and owns this file from then on. Asking the
// gate for a grant is server-only (lib/export-gate.ts) and has no method here.

// Why a run can't leave the lab right now (run_export_blocks). Empty means it can.
export type ShareBlock = "run_off" | "lab_off" | "demo_lab";

export type LabSharing = {
  // Null while the lab hasn't agreed.
  agreedAt: string | null;
  // The version of the wording that was agreed.
  agreement: string | null;
  // The viewer is an admin, so the lab's switch is theirs to change.
  canChange: boolean;
  // A demo lab's data is made up: it never exports, and anything shown outside says SAMPLE.
  demo: boolean;
};

export type SharingLogEntry = {
  id: number;
  runId: RunId | null;
  action: "run.share" | "lab.share" | "export.allowed" | "export.blocked";
  via: "person" | "worker" | "trigger" | "migration";
  actor: UserId | null;
  actorName: string | null;
  before: unknown;
  after: unknown;
  at: string;
};

export type SharingApi = {
  labSharing: (signal: AbortSignal) => Promise<LabSharing>;
  setLabShare: (on: boolean, agreement: string) => Promise<LabSharing>;
  setRunShare: (id: RunId, on: boolean) => Promise<RunRecord>;
  // One run's sharing history, or the whole lab's (null).
  sharingLog: (runId: RunId | null, signal: AbortSignal) => Promise<SharingLogEntry[]>;
};

export const httpSharingApi: SharingApi = {
  labSharing: notBuilt,
  setLabShare: notBuilt,
  setRunShare: notBuilt,
  sharingLog: notBuilt,
};
