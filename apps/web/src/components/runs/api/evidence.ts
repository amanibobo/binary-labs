import type { FileKind } from "@/lib/domain";
import type { ProtocolVersionId, RunId, Sha256 } from "@/lib/ids";
import type { RunRecord } from "@/lib/run-record";
import { notBuilt } from "./http";

// Slice B, originals and planned versus actual (brief items 2 and 3). The foundation typed
// this interface and left the bodies; the slice fills them in and owns this file from then on.

// One of a run's files beside what its place in the lab holds now.
export type RunOriginal = {
  sha256: Sha256;
  name: string;
  size: number;
  fileKind: FileKind;
  kept: boolean;
  // The same place now holds newer content; `asOf` is when this content was read there.
  editedSince: boolean;
  asOf: string | null;
  // The file is gone from the lab's folder. The run still opens its copy.
  removed: boolean;
};

// The two texts the difference is drawn from: the protocol as written, and the version the
// as-run text started from (the one to diff against).
export type PlanBodies = { planned: string | null; basedOn: string | null };

export type EvidenceApi = {
  originals: (id: RunId, signal: AbortSignal) => Promise<RunOriginal[]>;
  planBodies: (id: RunId, signal: AbortSignal) => Promise<PlanBodies>;
  setPlan: (id: RunId, versionId: ProtocolVersionId | null) => Promise<RunRecord>;
  saveAsRun: (id: RunId, input: { body: string; basedOn: ProtocolVersionId | null }) => Promise<RunRecord>;
};

export const httpEvidenceApi: EvidenceApi = {
  originals: notBuilt,
  planBodies: notBuilt,
  setPlan: notBuilt,
  saveAsRun: notBuilt,
};
