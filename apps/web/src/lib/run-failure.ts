import { z } from "zod";
import { PersonId, RunId, Sha256 } from "./ids";
import { ConfirmMethod, FailureTerm, fromRow, runFailure, type FailureFields, type RunFailure } from "./run-record";

// The failure record (decisions.md, "the run record: the failure record"): the shapes and words
// slice A adds on top of the run record's.

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");

// Someone who can be named as the confirmer: one of the lab's People. `you` is the viewer's own
// row; `account` says they can sign in and say yes themselves.
export const ConfirmerChoice = z.object({ id: PersonId, name: z.string(), you: z.boolean(), account: z.boolean() });
export type ConfirmerChoice = z.infer<typeof ConfirmerChoice>;
export const ConfirmerChoicesJson = fromRow(z.array(ConfirmerChoice));

// The newest version of the fixed list, and whether a working scientist has signed it off.
export const FailureList = z.object({
  version: z.number().int(),
  signedOffAt: Timestamp.nullable(),
  signedOffBy: z.string().nullable(),
  terms: z.array(FailureTerm),
});
export type FailureList = z.infer<typeof FailureList>;
export const FailureListJson = fromRow(FailureList);

// The three questions the picker asks, one per part of a code.
export const FAILURE_PARTS = [
  { part: "technique", prefix: "tech.", question: "What kind of experiment was it?", short: "Kind of experiment", any: "Any kind of experiment" },
  { part: "failedStep", prefix: "step.", question: "Where did it go wrong?", short: "Where it went wrong", any: "Any step" },
  { part: "causeCategory", prefix: "cause.", question: "What kind of problem was it?", short: "Kind of problem", any: "Any kind of problem" },
] as const satisfies readonly { part: keyof FailureFields; prefix: string; question: string; short: string; any: string }[];
export type FailurePart = (typeof FAILURE_PARTS)[number]["part"];

export function termsOf(list: FailureList, prefix: string): FailureTerm[] {
  return list.terms.filter((t) => t.code.startsWith(prefix)).sort((a, b) => a.position - b.position);
}

export function termLabel(list: FailureList | undefined, code: string | null): string | null {
  if (code === null) return null;
  return list?.terms.find((t) => t.code === code)?.label ?? code;
}

export const METHOD_CHOICES = [
  { method: "control", label: "A control", hint: "A control in this run showed it. Pick that file." },
  { method: "repeat", label: "A repeat", hint: "Doing it again showed it." },
  { method: "pi_opinion", label: "The PI's opinion", hint: "The PI or another senior person looked and said so." },
] as const satisfies readonly { method: ConfirmMethod; label: string; hint: string }[];

const METHOD_WORDS = { control: "with a control", repeat: "with a repeat", pi_opinion: "as the PI's opinion" } as const satisfies Record<ConfirmMethod, string>;
export const methodWords = (method: ConfirmMethod): string => METHOD_WORDS[method];

// ---- What the browser sends.

export const CAUSE_MAX = 4000;
export const NOTE_MAX = 2000;

// The confirmation's evidence follows its method, so a control without a file or a PI's
// opinion with one can't be sent.
const Evidence = z.discriminatedUnion("method", [
  z.object({ method: z.literal("control"), sha256: Sha256 }),
  z.object({ method: z.literal("repeat"), runId: RunId.nullable() }),
  z.object({ method: z.literal("pi_opinion") }),
]);
export type Evidence = z.infer<typeof Evidence>;

export const ConfirmDraft = z.object({
  cause: z.string().trim().min(1, "Write the cause in a few words.").max(CAUSE_MAX),
  personId: PersonId,
  evidence: Evidence,
  note: z.string().trim().max(NOTE_MAX).nullable(),
  // Now when it isn't given; the database refuses a time in the future.
  confirmedAt: Timestamp.nullable(),
});
export type ConfirmDraft = z.infer<typeof ConfirmDraft>;

export const CauseRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("suspect"), cause: z.string().max(CAUSE_MAX).nullable() }),
  z.object({ action: z.literal("confirm"), confirm: ConfirmDraft }),
  z.object({ action: z.literal("withdraw") }),
  z.object({ action: z.literal("attest") }),
]);
export type CauseRequest = z.infer<typeof CauseRequest>;

export const FailureType = z.object({
  version: z.number().int().positive(),
  technique: z.string().startsWith("tech.").max(60).nullable(),
  failedStep: z.string().startsWith("step.").max(60).nullable(),
  causeCategory: z.string().startsWith("cause.").max(60).nullable(),
});
export type FailureType = z.infer<typeof FailureType>;
export const FailureTypeRequest = z.object({ type: FailureType.nullable() });

// confirm_cause's arguments as the database names them.
export function confirmArgs(draft: ConfirmDraft): Record<string, string | null> {
  const { evidence } = draft;
  return {
    p_cause: draft.cause,
    p_person_id: draft.personId,
    p_method: evidence.method,
    p_note: draft.note === "" ? null : draft.note,
    p_confirmed_at: draft.confirmedAt,
    p_confirm_run: evidence.method === "repeat" ? evidence.runId : null,
    p_confirm_sha256: evidence.method === "control" ? evidence.sha256 : null,
  };
}

// The failure functions' errors, as the browser should see them; anything else reads as the
// run record's.
const FAILURES: Readonly<Record<string, RunFailure>> = {
  BL911: { status: 400, message: "That person isn't in this lab's People. Add them in Settings, then pick them." },
  BL912: { status: 403, message: "Only the person named as the confirmer can say yes, from their own account." },
  BL913: { status: 400, message: "A cause goes on a run that failed or was odd. Mark it Failed or Odd first." },
  BL914: { status: 400, message: "That doesn't fit how it was confirmed. A control needs one of this run's files; the PI's opinion needs none." },
  BL915: { status: 400, message: "That time is in the future. Pick when it was confirmed." },
  BL916: { status: 400, message: "That isn't on the failure list. Pick one from the list." },
  BL917: { status: 400, message: "Write it in a few words: a cause up to 4,000 characters, a note up to 2,000." },
};
export function failureFailure(error: { code?: string }): RunFailure {
  return FAILURES[error.code ?? ""] ?? runFailure(error);
}

// What the page says under a confirmed cause about the confirmer's own yes.
export type AttestState =
  | { kind: "attested"; at: string }
  | { kind: "yours" }
  | { kind: "waiting"; name: string }
  | { kind: "no_account"; name: string };

export function attestState(failure: Pick<FailureFields, "confirmedBy" | "confirmerAttestedAt">, choices: readonly ConfirmerChoice[]): AttestState | null {
  const by = failure.confirmedBy;
  if (by === null) return null;
  if (failure.confirmerAttestedAt !== null) return { kind: "attested", at: failure.confirmerAttestedAt };
  const choice = choices.find((c) => c.id === by.id);
  if (choice?.you === true) return { kind: "yours" };
  return choice?.account === false ? { kind: "no_account", name: by.name } : { kind: "waiting", name: by.name };
}
