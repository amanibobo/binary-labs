import type { PersonId, RunId, Sha256 } from "@/lib/ids";
import type { ConfirmMethod, FailureTerm, RunRecord } from "@/lib/run-record";
import { notBuilt } from "./http";

// Slice A, the failure record (brief item 1). The foundation typed this interface and left
// the bodies; the slice fills them in and owns this file from then on.

export type ConfirmInput = {
  cause: string;
  // The named confirmer: a person of the lab, who may have no account.
  personId: PersonId;
  method: ConfirmMethod;
  note: string | null;
  // What showed it: the repeat run, or the control file (one of this run's files).
  evidence: { runId: RunId | null; sha256: Sha256 | null };
};

export type FailureType = { version: number; technique: string | null; failedStep: string | null; causeCategory: string | null };

export type FailureApi = {
  // The fixed list (failure_terms), newest version, in picker order.
  failureTerms: (signal: AbortSignal) => Promise<FailureTerm[]>;
  setSuspectedCause: (id: RunId, cause: string | null) => Promise<RunRecord>;
  confirmCause: (id: RunId, input: ConfirmInput) => Promise<RunRecord>;
  // Only the named confirmer's own account can say "Yes, I confirmed this".
  attestCause: (id: RunId) => Promise<RunRecord>;
  setFailureType: (id: RunId, type: FailureType | null) => Promise<RunRecord>;
};

export const httpFailureApi: FailureApi = {
  failureTerms: notBuilt,
  setSuspectedCause: notBuilt,
  confirmCause: notBuilt,
  attestCause: notBuilt,
  setFailureType: notBuilt,
};
