import { z } from "zod";
import { IsoDate } from "./domain";
import { DebriefId, LocationId, RunId, UserId } from "./ids";
import { RunFix, type DebriefFields } from "./run-record";

// The debrief of a run that failed or was odd (decisions.md, "the run record: the debrief"):
// six fixed questions, each answered by a short recording or typed. Every word that reaches
// the run is the scientist's own: a transcript of what they said, their correction of it, or
// what they typed. No model writes any of it.

export const DEBRIEF_QUESTIONS = [
  { question: 1, ask: "What were you trying to do?", hint: "The aim of this run, in a sentence or two." },
  { question: 2, ask: "What did you expect, and what did you see?", hint: "What should have happened, then what actually happened." },
  { question: 3, ask: "What do you think went wrong?", hint: "Your best guess is fine. Say if you don't know." },
  { question: 4, ask: "How did you find out?", hint: "What you looked at or measured that told you." },
  { question: 5, ask: "What did you change, and did it fix it?", hint: "Say what you changed, then tap whether it fixed it." },
  { question: 6, ask: "Who else confirmed it, or could?", hint: "A name, or who in the lab would know." },
] as const;

// An answer is meant to be short; a recording stops by itself at three minutes.
export const ANSWER_MAX_MS = 3 * 60 * 1000;

export type DebriefQuestion = (typeof DEBRIEF_QUESTIONS)[number]["question"];
export const DebriefQuestion = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]);

export const FIX_CHOICES = [
  { fix: "yes", label: "Yes" },
  { fix: "no", label: "No" },
  { fix: "not_sure", label: "Not sure" },
] as const satisfies readonly { fix: RunFix; label: string }[];

// What a recording's transcript has got to.
export type Heard = { kind: "transcribing" } | { kind: "failed"; message: string } | { kind: "heard"; transcript: string };

// The words of one answer. A recording keeps the scientist's correction beside its
// transcript; "" is a correction that clears it.
export type AnswerWords =
  | { kind: "none" }
  | { kind: "typed"; text: string }
  | { kind: "recording"; audio: LocationId; heard: Heard; correction: string | null };

export type DebriefAnswer = { question: DebriefQuestion; words: AnswerWords; fixWorked: RunFix | null };

export type DebriefState = "open" | "approved" | "discarded";

export type Debrief = {
  id: DebriefId;
  runId: RunId;
  state: DebriefState;
  startedBy: UserId | null;
  startedAt: string;
  approvedAt: string | null;
  // Only the questions with an answer or a tap; one left out is missing.
  answers: DebriefAnswer[];
};

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");

const HeardWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transcribing") }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
  z.object({ kind: z.literal("heard"), transcript: z.string() }),
]) satisfies z.ZodType<Heard>;

const AnswerWordsWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("typed"), text: z.string() }),
  z.object({ kind: z.literal("recording"), audio: LocationId, heard: HeardWire, correction: z.string().nullable() }),
]) satisfies z.ZodType<AnswerWords>;

export const Debrief = z.object({
  id: DebriefId,
  runId: RunId,
  state: z.enum(["open", "approved", "discarded"]),
  startedBy: UserId.nullable(),
  startedAt: Timestamp,
  approvedAt: Timestamp.nullable(),
  answers: z.array(z.object({ question: DebriefQuestion, words: AnswerWordsWire, fixWorked: RunFix.nullable() })),
}) satisfies z.ZodType<Debrief>;

const NOT_HEARD = "We couldn't make out this recording. Record it again or type it.";

const AnswerRow = z
  .object({
    question: DebriefQuestion,
    typed: z.boolean(),
    text: z.string().nullable(),
    fix_worked: RunFix.nullable(),
    recording: z
      .object({
        location_id: LocationId,
        index_state: z.enum(["pending", "indexed", "failed"]),
        error: z.string().nullable(),
        transcript: z.string().nullable(),
      })
      .nullable(),
  })
  .transform((a): DebriefAnswer => ({ question: a.question, words: wordsOf(a), fixWorked: a.fix_worked }));

function wordsOf(a: { typed: boolean; text: string | null; recording: { location_id: LocationId; index_state: "pending" | "indexed" | "failed"; transcript: string | null } | null }): AnswerWords {
  if (a.typed) return a.text === null ? { kind: "none" } : { kind: "typed", text: a.text };
  if (a.recording === null) return { kind: "none" };
  const r = a.recording;
  const heard: Heard =
    r.index_state === "pending"
      ? { kind: "transcribing" }
      : r.index_state === "failed"
        ? { kind: "failed", message: NOT_HEARD }
        : { kind: "heard", transcript: r.transcript ?? "" };
  return { kind: "recording", audio: r.location_id, heard, correction: a.text };
}

// debrief_json() and run_debrief(), as the app's shape; null when there's no debrief.
export const DebriefJson = z
  .object({
    id: DebriefId,
    run_id: RunId,
    state: z.enum(["open", "approved", "discarded"]),
    started_by: UserId.nullable(),
    started_at: Timestamp,
    approved_at: Timestamp.nullable(),
    answers: z.array(AnswerRow),
  })
  .transform(
    (d): Debrief => ({ id: d.id, runId: d.run_id, state: d.state, startedBy: d.started_by, startedAt: d.started_at, approvedAt: d.approved_at, answers: d.answers }),
  );
export const MaybeDebriefJson = DebriefJson.nullable();

export function answerTo(debrief: Pick<Debrief, "answers">, question: DebriefQuestion): DebriefAnswer | null {
  return debrief.answers.find((a) => a.question === question) ?? null;
}

// The words the run takes for an answer, as approve_debrief builds them: what was typed, else
// the correction, else the transcript. Null reads "Missing".
export function answerText(words: AnswerWords): string | null {
  const text = (() => {
    switch (words.kind) {
      case "none":
        return null;
      case "typed":
        return words.text;
      case "recording":
        return words.correction ?? (words.heard.kind === "heard" ? words.heard.transcript : null);
      default: {
        const _exhaustive: never = words;
        return _exhaustive;
      }
    }
  })();
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

// What still stands between the review screen and "Save to the run".
export type Holdup = { kind: "transcribing"; questions: DebriefQuestion[] } | { kind: "not_heard"; questions: DebriefQuestion[] };

export function holdup(debrief: Pick<Debrief, "answers">): Holdup | null {
  const stuck = (kind: Heard["kind"]) =>
    debrief.answers.flatMap((a) => (a.words.kind === "recording" && a.words.correction === null && a.words.heard.kind === kind ? [a.question] : []));
  const transcribing = stuck("transcribing");
  if (transcribing.length > 0) return { kind: "transcribing", questions: transcribing };
  const failed = stuck("failed");
  return failed.length > 0 ? { kind: "not_heard", questions: failed } : null;
}

export function isTranscribing(debrief: Pick<Debrief, "answers">): boolean {
  return debrief.answers.some((a) => a.words.kind === "recording" && a.words.heard.kind === "transcribing");
}

// The questions with nothing said, in order: what the review screen marks "Missing".
export function missingQuestions(debrief: Pick<Debrief, "answers">): DebriefQuestion[] {
  return DEBRIEF_QUESTIONS.flatMap(({ question }) => {
    const answer = answerTo(debrief, question);
    const said = answer !== null && answerText(answer.words) !== null;
    const tapped = question === 5 && answer?.fixWorked != null;
    return said || tapped ? [] : [question];
  });
}

// The run's saved answers, question by question, for the run page. Question 3 isn't a column:
// it reaches the run only as the suspected cause, so the page reads it from the debrief.
export const RUN_ANSWER_FIELDS = {
  1: "aim",
  2: "expectedSeen",
  4: "howFound",
  5: "whatChanged",
  6: "whoElse",
} as const satisfies Partial<Record<DebriefQuestion, keyof DebriefFields>>;

export const FIX_LABELS: Readonly<Record<RunFix, string>> = { yes: "It fixed it.", no: "It didn't fix it.", not_sure: "Not sure it fixed it." };

// ---- What the browser sends.

// One answer's recording goes up through /api/uploads like any upload; these headers say
// which debrief and question it answers.
export const DEBRIEF_UPLOAD_PURPOSE = "run-debrief";
export const DEBRIEF_HEADERS = { purpose: "x-upload-purpose", debrief: "x-debrief-id", question: "x-debrief-question" } as const;

export type DebriefAnswerMeta = { debriefId: DebriefId; question: DebriefQuestion; name: string; uploadedOn: string };

export function debriefAnswerHeaders(meta: DebriefAnswerMeta): Record<string, string> {
  return {
    [DEBRIEF_HEADERS.purpose]: DEBRIEF_UPLOAD_PURPOSE,
    [DEBRIEF_HEADERS.debrief]: meta.debriefId,
    [DEBRIEF_HEADERS.question]: String(meta.question),
    "x-upload-name": encodeURIComponent(meta.name),
    "x-upload-date": meta.uploadedOn,
  };
}

export function isDebriefUpload(headers: Headers): boolean {
  return headers.get(DEBRIEF_HEADERS.purpose) === DEBRIEF_UPLOAD_PURPOSE;
}

const DebriefAnswerHeaders = z.object({
  debriefId: DebriefId,
  question: z.coerce.number().pipe(DebriefQuestion),
  name: z
    .string()
    .transform((s, ctx) => {
      try {
        return decodeURIComponent(s);
      } catch {
        ctx.addIssue({ code: "custom", message: "not URI-encoded" });
        return z.NEVER;
      }
    })
    .pipe(z.string().trim().min(1).max(200)),
  uploadedOn: IsoDate,
});

export function parseDebriefAnswerHeaders(headers: Headers): DebriefAnswerMeta | null {
  const read = (name: string) => headers.get(name) ?? undefined;
  const parsed = DebriefAnswerHeaders.safeParse({
    debriefId: read(DEBRIEF_HEADERS.debrief),
    question: read(DEBRIEF_HEADERS.question),
    name: read("x-upload-name"),
    uploadedOn: read("x-upload-date"),
  });
  return parsed.success ? parsed.data : null;
}

// record_debrief_answer's arguments, by name, as supabase-js sends them.
export function recordDebriefAnswerArgs(sha256: string, size: number, meta: DebriefAnswerMeta) {
  return {
    p_debrief_id: meta.debriefId,
    p_question: meta.question,
    p_sha256: sha256,
    p_size: size,
    p_name: meta.name,
    p_uploaded_on: meta.uploadedOn,
    p_modified_at: null,
  };
}
export type RecordDebriefAnswerArgs = ReturnType<typeof recordDebriefAnswerArgs>;

const pad = (n: number) => String(n).padStart(2, "0");

export function debriefAnswerName(at: Date, question: DebriefQuestion, extension: string): string {
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `Debrief ${day} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())} question ${question}.${extension}`;
}

// A change to an open debrief: words for a question (typed, or a correction of a recording's
// transcript), question 5's tap, or saving it to the run.
export const DebriefChange = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("text"),
    question: DebriefQuestion,
    text: z.string().max(20_000, "Keep an answer under 20,000 characters."),
    correction: z.boolean(),
  }),
  z.object({ action: z.literal("fix"), fix: RunFix.nullable() }),
  z.object({ action: z.literal("approve"), useAsSuspected: z.boolean() }),
]);
export type DebriefChange = z.infer<typeof DebriefChange>;

// A database error from a debrief function, as the browser should see it.
export type DebriefFailure = { status: 400 | 403 | 404 | 409 | 413; message: string } | { status: 500; message: string };
const FAILURES: Readonly<Record<string, DebriefFailure>> = {
  "42501": { status: 403, message: "That run belongs to another lab." },
  BL907: { status: 404, message: "That run doesn't exist any more." },
  BL941: { status: 409, message: "Only a run that failed or was odd has these questions. Mark how it went first." },
  BL942: { status: 404, message: "Those answers don't exist any more." },
  BL943: { status: 409, message: "These answers were already saved or thrown away. Open the run to see them." },
  BL944: { status: 409, message: "An answer is still being written out. Wait a moment, then try again." },
  BL945: { status: 409, message: "We couldn't make out one of the recordings. Record it again or type it." },
  BL946: { status: 400, message: "There's no answer to question 3 to use as the suspected cause." },
  BL201: { status: 413, message: "That recording is too large." },
  "22023": { status: 400, message: "That answer couldn't be saved. Check it and try again." },
};
export function debriefFailure(error: { code?: string }): DebriefFailure {
  return FAILURES[error.code ?? ""] ?? { status: 500, message: "We couldn't save that. Try again." };
}
