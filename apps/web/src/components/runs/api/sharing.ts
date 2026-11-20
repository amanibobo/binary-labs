import { z } from "zod";
import { RunId, UserId } from "@/lib/ids";
import { fromRow, RunRecord } from "@/lib/run-record";
import { getJson, send } from "./http";

// Slice C, sharing and the export gate (brief item 4): the shapes, the words and the browser's
// methods. Asking the gate for a grant is server-only (lib/export-gate.ts) and has no method
// here.

// The wording an admin agrees to for the lab. Placeholder text until a lawyer has read it;
// the database stores `version`, so what a lab agreed to is known after the wording changes.
export const SHARING_AGREEMENT = {
  version: "draft-1",
  draftNote: "Draft wording. A lawyer hasn't read this yet, and it will change before any real lab's data is shared.",
  paragraphs: [
    "The lab agrees that runs its members switch on can be shared outside the lab with AI research teams, as material for training and testing AI models.",
    "Nothing is shared unless this agreement is on and the run's own switch is on. Each run's switch is off until the person who ran it, or an admin, turns it on.",
    "Any admin can take this agreement back at any time. Binary then removes the copies it holds. Copies already sent to someone else can't be pulled back.",
  ],
} as const;

// The one sentence under a run's switch.
export const RUN_SHARE_MEANING =
  "Turning this on lets Binary include this run, with its files and its cause, in what the lab shares outside the lab with AI research teams.";
export const RUN_SHARE_DRAFT_NOTE = "Draft wording, not yet read by a lawyer.";
export const SENT_COPIES_LINE = "Copies already sent to someone else can't be pulled back.";

// Why a run can't leave the lab right now. Empty means it can.
export const ShareBlock = z.enum(["run_off", "lab_off", "demo_lab", "not_attested"]);
export type ShareBlock = z.infer<typeof ShareBlock>;

export const BLOCK_WORDS: Readonly<Record<ShareBlock, string>> = {
  run_off: "this run's sharing is off",
  lab_off: "the lab hasn't agreed to share",
  demo_lab: "this is a demo lab, and its data is made up",
  not_attested: "the person named as confirming the cause hasn't said so themselves",
};

export const LabSharing = z.object({
  // Null while the lab hasn't agreed.
  agreedAt: z.string().nullable(),
  // The version of the wording that was agreed.
  agreement: z.string().nullable(),
  agreedBy: z.string().nullable(),
  // The viewer is an admin, so the lab's agreement is theirs to change.
  canChange: z.boolean(),
  // A demo lab's data is made up: it never exports, and anything shown outside says SAMPLE.
  demo: z.boolean(),
  // Task folders built from the lab's runs that still stand.
  built: z.number().int(),
});
export type LabSharing = z.infer<typeof LabSharing>;

export const RunSharing = z.object({
  share: z.boolean(),
  // The viewer ran it or is an admin, so its switch is theirs to change.
  canChange: z.boolean(),
  blocks: z.array(ShareBlock),
  built: z.number().int(),
  withdrawn: z.number().int(),
});
export type RunSharing = z.infer<typeof RunSharing>;

export const SharingLogEntry = z.object({
  id: z.number().int(),
  runId: RunId.nullable(),
  runTitle: z.string().nullable(),
  action: z.enum(["run.share", "lab.share", "export.allowed", "export.blocked"]),
  via: z.enum(["person", "worker", "trigger", "migration"]),
  actor: UserId.nullable(),
  // Null for someone who isn't in the lab, and for Binary itself.
  actorName: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  at: z.string(),
});
export type SharingLogEntry = z.infer<typeof SharingLogEntry>;

export const LabSharingJson = fromRow(LabSharing);
export const RunSharingJson = fromRow(RunSharing);
export const SharingLogJson = fromRow(z.array(SharingLogEntry));

export const SetRunShareRequest = z.object({ on: z.boolean() });
export const SetLabShareRequest = z.object({ on: z.boolean(), agreement: z.string().max(100) });

// What one log row says happened. A row whose details don't parse reads as "other", never as
// something it might not be.
export type SharingEvent =
  | { kind: "run_on" }
  | { kind: "run_off"; byItself: boolean }
  | { kind: "lab_on"; agreement: string }
  | { kind: "lab_off" }
  | { kind: "allowed" }
  | { kind: "blocked"; blocks: ShareBlock[] }
  | { kind: "outsider" }
  | { kind: "withdrawn"; folders: number }
  | { kind: "other" };

const ShareAfter = z.object({ share: z.boolean() });
const AgreementAfter = z.object({ agreement: z.string().nullable() });
const BlockedAfter = z.object({ blocks: z.array(z.string()), folders: z.number().int().optional() });

export function sharingEvent(entry: Pick<SharingLogEntry, "action" | "via" | "after">): SharingEvent {
  switch (entry.action) {
    case "run.share": {
      const after = ShareAfter.safeParse(entry.after);
      if (!after.success) return { kind: "other" };
      return after.data.share ? { kind: "run_on" } : { kind: "run_off", byItself: entry.via === "trigger" };
    }
    case "lab.share": {
      const after = AgreementAfter.safeParse(entry.after);
      if (!after.success) return { kind: "other" };
      return after.data.agreement === null ? { kind: "lab_off" } : { kind: "lab_on", agreement: after.data.agreement };
    }
    case "export.allowed":
      return { kind: "allowed" };
    case "export.blocked": {
      const after = BlockedAfter.safeParse(entry.after);
      if (!after.success) return { kind: "other" };
      if (after.data.blocks.includes("withdrawn")) return { kind: "withdrawn", folders: after.data.folders ?? 0 };
      if (after.data.blocks.includes("not_member")) return { kind: "outsider" };
      const blocks = z.array(ShareBlock).safeParse(after.data.blocks);
      return blocks.success ? { kind: "blocked", blocks: blocks.data } : { kind: "other" };
    }
    default: {
      const _exhaustive: never = entry.action;
      return _exhaustive;
    }
  }
}

export const folderCount = (n: number) => (n === 1 ? "1 task folder" : `${n} task folders`);

// Several reasons as one clause: "a, b and c".
export function blockWords(blocks: readonly ShareBlock[]): string {
  const words = blocks.map((b) => BLOCK_WORDS[b]);
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

// One log row as a sentence. `subject` is "this run" on a run's page, the run's name in the
// lab's log.
export function sharingLogLine(entry: Pick<SharingLogEntry, "action" | "via" | "after" | "actorName" | "actor">, subject: string): string {
  const who = entry.actorName ?? (entry.actor === null ? "Binary" : "Someone who isn't in the lab");
  const event = sharingEvent(entry);
  switch (event.kind) {
    case "run_on":
      return `${who} turned sharing on for ${subject}.`;
    case "run_off":
      return event.byItself ? `Sharing went off for ${subject} because ${who} changed the run.` : `${who} turned sharing off for ${subject}.`;
    case "lab_on":
      return `${who} agreed to share for the lab (wording ${event.agreement}).`;
    case "lab_off":
      return `${who} took back the lab's agreement to share.`;
    case "allowed":
      return `${who} asked to export ${subject}. Allowed.`;
    case "blocked":
      return `${who} asked to export ${subject}. Blocked: ${blockWords(event.blocks)}.`;
    case "outsider":
      return `Someone who isn't in the lab asked to export ${subject}. Blocked.`;
    case "withdrawn":
      return `${folderCount(event.folders)} built from ${subject} withdrawn. Binary removes its copies. ${SENT_COPIES_LINE}`;
    case "other":
      return `${who} changed sharing for ${subject}.`;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export type SharingApi = {
  labSharing: (signal: AbortSignal) => Promise<LabSharing>;
  // `agreement` is the version of the wording the admin was shown.
  setLabShare: (on: boolean, agreement: string) => Promise<LabSharing>;
  runSharing: (id: RunId, signal: AbortSignal) => Promise<RunSharing>;
  setRunShare: (id: RunId, on: boolean) => Promise<RunRecord>;
  // One run's sharing history, or the whole lab's (null, admins only).
  sharingLog: (runId: RunId | null, signal: AbortSignal) => Promise<SharingLogEntry[]>;
};

const base = "/api/run-records";
const Log = z.object({ log: z.array(SharingLogEntry) });

export const httpSharingApi: SharingApi = {
  labSharing: async (signal) => LabSharing.parse(await getJson(`${base}/sharing`, {}, signal)),
  setLabShare: async (on, agreement) => LabSharing.parse(await send(`${base}/sharing`, "POST", { on, agreement })),
  runSharing: async (id, signal) => RunSharing.parse(await getJson(`${base}/${id}/share`, {}, signal)),
  setRunShare: async (id, on) => RunRecord.parse(await send(`${base}/${id}/share`, "POST", { on })),
  sharingLog: async (runId, signal) => Log.parse(await getJson(runId === null ? `${base}/sharing/log` : `${base}/${runId}/share/log`, {}, signal)).log,
};
