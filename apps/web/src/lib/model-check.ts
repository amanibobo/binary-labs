import { z } from "zod";
import { RunId } from "./ids";
import { fromRow } from "./run-record";

// The model check (decisions.md, "the run record: the model check"): a few frontier models
// answer a built task, a grader judges each answer against the confirmed cause, and a second
// scientist judges what the grader couldn't settle. The worker does the sending; this file is
// the shapes the page reads and the words it shows.

export const TaskId = z.uuid().brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;
export const AnswerId = z.uuid().brand<"AnswerId">();
export type AnswerId = z.infer<typeof AnswerId>;

export const Verdict = z.enum(["solved", "partial", "not_solved", "unclear"]);
export type Verdict = z.infer<typeof Verdict>;
export const AnswerState = z.enum(["waiting", "answered", "failed", "refused", "skipped"]);
export type AnswerState = z.infer<typeof AnswerState>;

const money = z.coerce.number();

export const ModelAnswer = z.object({
  id: AnswerId,
  model: z.string(),
  state: AnswerState,
  answer: z.string().nullable(),
  verdict: Verdict.nullable(),
  reason: z.string().nullable(),
  // Whether it solved the task: the second scientist's judgment when there is one, else the
  // grader's verdict. Empty while nobody has settled it.
  solved: z.boolean().nullable(),
  error: z.string().nullable(),
  costUsd: money,
  judgedBy: z.string().nullable(),
  judgedNote: z.string().nullable(),
  judgedAt: z.string().nullable(),
});
export type ModelAnswer = z.infer<typeof ModelAnswer>;

export const ModelCheck = z.object({
  id: z.uuid(),
  requestedAt: z.string(),
  costCapUsd: money,
  spentUsd: money,
  answers: z.array(ModelAnswer),
});
export type ModelCheck = z.infer<typeof ModelCheck>;

export const CheckedTask = z.object({
  taskId: TaskId,
  builtAt: z.string(),
  withdrawnAt: z.string().nullable(),
  keptAt: z.string().nullable(),
  keptBy: z.string().nullable(),
  check: ModelCheck.nullable(),
});
export type CheckedTask = z.infer<typeof CheckedTask>;

// What the worker last said it can run. Null when the worker has never said.
export const CheckSetup = z.object({
  models: z.array(z.object({ model: z.string(), ceilingUsd: money })),
  unreachable: z.array(z.object({ model: z.string(), needs: z.string() })),
  grader: z.string().nullable(),
  costCapUsd: money,
  ceilingUsd: money,
  missing: z.array(z.string()),
  ready: z.boolean(),
});
export type CheckSetup = z.infer<typeof CheckSetup>;

export const RubricItem = z.object({ criterion: z.string(), points: z.number() });

export const RunModelChecks = z.object({
  runId: RunId,
  title: z.string(),
  setup: CheckSetup.nullable(),
  confirmedCause: z.string().nullable(),
  question: z.string().nullable(),
  // E writes {criterion, points}; anything else is shown as it reads.
  rubric: z.array(z.union([RubricItem, z.unknown().transform((v) => ({ criterion: typeof v === "string" ? v : JSON.stringify(v), points: 0 }))])),
  canJudge: z.boolean(),
  tasks: z.array(CheckedTask),
});
export type RunModelChecks = z.infer<typeof RunModelChecks>;
export const RunModelChecksJson = fromRow(RunModelChecks);

export const ModelCheckRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), taskId: TaskId }),
  z.object({ action: z.literal("judge"), answerId: AnswerId, solved: z.boolean().nullable(), note: z.string().max(2000).default("") }),
  z.object({ action: z.literal("keep"), taskId: TaskId, keep: z.boolean() }),
]);
export type ModelCheckRequest = z.infer<typeof ModelCheckRequest>;

const FAILURES: Readonly<Record<string, { status: number; message: string }>> = {
  BL907: { status: 404, message: "That run doesn't exist any more." },
  "42501": { status: 403, message: "You can only do that in your own lab." },
  BL951: { status: 409, message: "Sharing is off for this run, so nothing about it can go to a model. Turn sharing on and build the task again." },
  BL971: { status: 404, message: "That task doesn't exist any more." },
  BL972: { status: 409, message: "The model check isn't set up yet. Add the keys this page names." },
  BL973: { status: 409, message: "The models are still answering this task. Wait for them to finish." },
  BL974: { status: 409, message: "That model didn't answer, so there's nothing to judge." },
  BL975: { status: 403, message: "You ran this experiment, so someone else needs to judge the answers." },
  BL976: { status: 409, message: "This task was withdrawn, so it can't be kept." },
};

export function modelCheckFailure(error: { code?: string }): { status: number; message: string } {
  return FAILURES[error.code ?? ""] ?? { status: 500, message: "We couldn't save that. Try again." };
}

// ---- What the page counts and says.

export type Tally = {
  // Answers that count toward "of N": every model that answered.
  answered: number;
  solved: number;
  notSolved: number;
  // Answered, but neither the grader nor a scientist has settled it.
  toJudge: number;
  waiting: number;
  // Asked but never answered: unreachable, refused, or skipped for cost.
  missed: number;
};

export function tally(answers: readonly ModelAnswer[]): Tally {
  const answered = answers.filter((a) => a.state === "answered");
  return {
    answered: answered.length,
    solved: answered.filter((a) => a.solved === true).length,
    notSolved: answered.filter((a) => a.solved === false).length,
    toJudge: answered.filter((a) => a.solved === null).length,
    waiting: answers.filter((a) => a.state === "waiting").length,
    missed: answers.filter((a) => a.state !== "answered" && a.state !== "waiting").length,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// The line at the top of a checked task.
export function headline(t: Tally): string {
  if (t.waiting > 0) return `Checking. ${t.answered} of ${t.answered + t.waiting} models have answered.`;
  if (t.answered === 0) return "No model answered.";
  return `Solved by ${t.solved} of ${plural(t.answered, "model", "models")}`;
}

// The line under it, when something is still open.
export function headlineNote(t: Tally): string | null {
  const parts: string[] = [];
  if (t.toJudge > 0) parts.push(`${plural(t.toJudge, "answer needs", "answers need")} a second scientist to judge it against the rubric.`);
  if (t.missed > 0) parts.push(`${plural(t.missed, "model", "models")} didn't answer.`);
  return parts.length === 0 ? null : parts.join(" ");
}

// "Keep this task" is offered once every answer is settled and most models failed it.
export function keepOffered(t: Tally): boolean {
  return t.waiting === 0 && t.toJudge === 0 && t.answered > 0 && t.notSolved * 2 > t.answered;
}

export type AnswerMark = { kind: "solved" | "not_solved" | "to_judge" | "waiting" | "missed"; text: string };

// What a model's row says it came to, and on whose word.
export function answerMark(a: ModelAnswer): AnswerMark {
  if (a.state === "waiting") return { kind: "waiting", text: "Waiting for an answer" };
  if (a.state !== "answered") return { kind: "missed", text: MISSED[a.state] };
  if (a.solved === null) return { kind: "to_judge", text: a.verdict === "partial" ? "Partly right. Needs a second scientist" : "Unclear. Needs a second scientist" };
  const who = a.judgedBy === null && a.judgedAt === null ? "the grader" : (a.judgedBy ?? "a second scientist");
  return a.solved ? { kind: "solved", text: `Solved, says ${who}` } : { kind: "not_solved", text: `Not solved, says ${who}` };
}

const MISSED: Readonly<Record<Exclude<AnswerState, "answered" | "waiting">, string>> = {
  failed: "Didn't answer",
  refused: "Not sent: sharing went off first",
  skipped: "Not sent",
};

// Why a model didn't answer, in plain words. The worker writes a short code or a provider's
// message; the codes are the ones it knows.
export function missedLine(a: ModelAnswer): string | null {
  if (a.state === "answered" || a.state === "waiting") return null;
  const KNOWN: Readonly<Record<string, string>> = {
    cost_cap: "Asking it could have passed this check's cost cap, so Binary stopped before it.",
    too_long: "This task is too long to send to a model.",
    no_key: "The worker has no key for this model.",
    not_shared: "Sharing for this run went off before Binary sent it.",
    no_answer: "It replied without an answer.",
  };
  return KNOWN[a.error ?? ""] ?? (a.error === null ? null : "It couldn't be reached.");
}

// Model names as people say them. Anything else shows the part after the provider.
const NAMES: Readonly<Record<string, string>> = {
  "anthropic/claude-opus-5.5": "Claude Opus 5.5",
  "anthropic/claude-sonnet-5.5": "Claude Sonnet 5.5",
  "anthropic/claude-fable-5.2": "Claude Fable 5.2",
  "openai/gpt-6.2-astra": "GPT-6.2 Astra",
  "google/gemini-4-neon": "Gemini 4 Neon",
  "x-ai/grok-4.7": "Grok 4.7",
};

export function modelName(model: string): string {
  return NAMES[model] ?? model.slice(model.indexOf("/") + 1);
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// What the start button promises before anything is sent.
export function costLine(setup: Pick<CheckSetup, "ceilingUsd" | "costCapUsd">): string {
  const most = setup.ceilingUsd < 0.01 ? "under $0.01" : `at most ${usd(setup.ceilingUsd)}`;
  return `This check costs ${most}. Binary stops before it would pass ${usd(setup.costCapUsd)}.`;
}
