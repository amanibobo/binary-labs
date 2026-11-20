import { z } from "zod";
import type { PersonId, RunId } from "@/lib/ids";
import { ConfirmerChoice, FailureList, type CauseRequest, type ConfirmDraft, type FailureType } from "@/lib/run-failure";
import { RunRecord } from "@/lib/run-record";
import { getJson, send } from "./http";

// Slice A, the failure record (brief item 1): the suspected and confirmed cause, the named
// confirmer's own yes, and the failure type from the fixed list.

export type FailureApi = {
  // The fixed list (failure_terms), newest version, in picker order.
  failureList: (signal: AbortSignal) => Promise<FailureList>;
  // The lab's People, who can be named as the confirmer; `you` marks the viewer's own row.
  confirmerChoices: (id: RunId, signal: AbortSignal) => Promise<ConfirmerChoice[]>;
  setSuspectedCause: (id: RunId, cause: string | null) => Promise<RunRecord>;
  confirmCause: (id: RunId, draft: ConfirmDraft) => Promise<RunRecord>;
  withdrawCause: (id: RunId) => Promise<RunRecord>;
  // Only the named confirmer's own account can say "Yes, I confirmed this".
  attestCause: (id: RunId) => Promise<RunRecord>;
  // "This is me": the viewer, who isn't anyone in People yet, links themselves to this person.
  claimPerson: (id: RunId, personId: PersonId) => Promise<RunRecord>;
  setFailureType: (id: RunId, type: FailureType | null) => Promise<RunRecord>;
};

const base = "/api/run-records";
const cause = async (id: RunId, body: CauseRequest) => RunRecord.parse(await send(`${base}/${id}/cause`, "POST", body));

export const httpFailureApi: FailureApi = {
  failureList: async (signal) => FailureList.parse(await getJson(`${base}/failure-terms`, {}, signal)),
  confirmerChoices: async (id, signal) => z.object({ people: z.array(ConfirmerChoice) }).parse(await getJson(`${base}/${id}/cause`, {}, signal)).people,
  setSuspectedCause: (id, text) => cause(id, { action: "suspect", cause: text }),
  confirmCause: (id, draft) => cause(id, { action: "confirm", confirm: draft }),
  withdrawCause: (id) => cause(id, { action: "withdraw" }),
  attestCause: (id) => cause(id, { action: "attest" }),
  claimPerson: (id, personId) => cause(id, { action: "claim", personId }),
  setFailureType: async (id, type) => RunRecord.parse(await send(`${base}/${id}/failure-type`, "POST", { type })),
};
