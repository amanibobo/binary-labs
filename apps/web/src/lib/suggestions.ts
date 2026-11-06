import { z } from "zod";
import { AnswerSource } from "./answers";
import { ExperimentId, PersonId, ProtocolId, ProtocolVersionId, QuestionId, Sha256, SuggestionId, UserId } from "./ids";
import { BODY_MAX, NOTE_MAX, TITLE_MAX } from "./protocols";

// Changes the AI proposed that wait for a member: a new protocol version drafted on a fork of
// the current one, or label fixes for files. Shared by the routes and the suggestion page.

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");

export const SuggestionState = z.enum(["open", "approved", "dismissed"]);
export type SuggestionState = z.infer<typeof SuggestionState>;

const Decision = z.object({
  state: SuggestionState,
  decidedBy: UserId.nullable(),
  decidedAt: Timestamp.nullable(),
});

const Common = {
  id: SuggestionId,
  questionId: QuestionId.nullable(),
  summary: z.string(),
  sources: z.array(AnswerSource),
  requestedBy: UserId.nullable(),
  createdAt: Timestamp,
  decision: Decision,
};

export const ProtocolEditSuggestion = z.object({
  ...Common,
  kind: z.literal("protocol_edit"),
  protocolId: ProtocolId,
  baseVersionId: ProtocolVersionId,
  baseVersion: z.number().int().positive(),
  // The version it was drafted from, to diff against.
  before: z.object({ title: z.string(), body: z.string() }),
  draft: z.object({ title: z.string(), body: z.string(), note: z.string().nullable() }),
  // Someone saved the protocol since the draft, so approving it would overwrite them.
  stale: z.boolean(),
  appliedVersion: z.number().int().positive().nullable(),
});
export type ProtocolEditSuggestion = z.infer<typeof ProtocolEditSuggestion>;

const LabelFacts = z.object({
  cleanName: z.string().nullable(),
  date: z.string().nullable(),
  experiment: z.string().nullable(),
  person: z.string().nullable(),
});
export type LabelFacts = z.infer<typeof LabelFacts>;

export const LabelChange = z.object({
  sha256: Sha256,
  path: z.string(),
  current: LabelFacts,
  // Only the fields this change sets; null fields stay as they are.
  proposed: LabelFacts,
  reason: z.string(),
  applied: z.boolean(),
});
export type LabelChange = z.infer<typeof LabelChange>;

export const LabelSuggestion = z.object({ ...Common, kind: z.literal("labels"), changes: z.array(LabelChange) });
export type LabelSuggestion = z.infer<typeof LabelSuggestion>;

export const Suggestion = z.discriminatedUnion("kind", [ProtocolEditSuggestion, LabelSuggestion]);
export type Suggestion = z.infer<typeof Suggestion>;

export const OpenSuggestion = z.object({ id: SuggestionId, kind: z.enum(["protocol_edit", "labels"]), summary: z.string(), createdAt: Timestamp });
export type OpenSuggestion = z.infer<typeof OpenSuggestion>;

// --- Requests ---

export const SuggestRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("protocol_edit"), protocolId: ProtocolId, questionId: QuestionId.nullable().default(null) }),
  z.object({ kind: z.literal("labels"), questionId: QuestionId }),
]);
export type SuggestRequest = z.input<typeof SuggestRequest>;

export const SuggestOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), id: SuggestionId }),
  // The model found nothing in the lab's records that called for a change.
  z.object({ kind: z.literal("none"), message: z.string() }),
  z.object({ kind: z.literal("limit"), message: z.string() }),
]);
export type SuggestOutcome = z.infer<typeof SuggestOutcome>;

export const ApproveRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("protocol_edit"),
    // Present when the member edited the draft first.
    edit: z
      .object({
        title: z.string().trim().min(1).max(TITLE_MAX),
        body: z.string().max(BODY_MAX),
        note: z.string().trim().max(NOTE_MAX).nullable(),
      })
      .nullable(),
  }),
  z.object({ kind: z.literal("labels"), shas: z.array(Sha256).min(1).max(50) }),
]);
export type ApproveRequest = z.input<typeof ApproveRequest>;

export const ApproveOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approved"), protocolId: ProtocolId.nullable(), version: z.number().int().positive().nullable(), applied: z.number().int().nonnegative() }),
  // Someone saved the protocol since this was drafted.
  z.object({ kind: z.literal("stale") }),
]);
export type ApproveOutcome = z.infer<typeof ApproveOutcome>;

// --- Rows ---

export const SuggestionRow = z.object({
  id: SuggestionId,
  kind: z.enum(["protocol_edit", "labels"]),
  state: SuggestionState,
  question_id: QuestionId.nullable(),
  requested_by: UserId.nullable(),
  summary: z.string(),
  sources: z.array(AnswerSource),
  protocol_id: ProtocolId.nullable(),
  base_version_id: ProtocolVersionId.nullable(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  note: z.string().nullable(),
  created_at: Timestamp,
  decided_by: UserId.nullable(),
  decided_at: Timestamp.nullable(),
  applied_version_id: ProtocolVersionId.nullable(),
});
export type SuggestionRow = z.infer<typeof SuggestionRow>;

export const SuggestionLabelRow = z.object({
  sha256: Sha256,
  clean_name: z.string().nullable(),
  date: z.string().nullable(),
  experiment_id: ExperimentId.nullable(),
  person_id: PersonId.nullable(),
  reason: z.string(),
  correction_id: z.number().nullable(),
});
export type SuggestionLabelRow = z.infer<typeof SuggestionLabelRow>;

export function suggestionHref(id: SuggestionId): string {
  return `/suggestions/${id}`;
}

// --- A line diff for the protocol edit ---

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

// Longest common subsequence over lines. Protocols are a few hundred lines at most; past a
// size where the table would be large, it shows the whole old text removed and the new added.
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) {
    return [...a.map((text) => ({ kind: "removed" as const, text })), ...b.map((text) => ({ kind: "added" as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i];
    const below = lcs[i + 1];
    if (row === undefined || below === undefined) continue;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ kind: "removed", text: a[i] ?? "" });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j] ?? "" });
      j += 1;
    }
  }
  for (; i < n; i++) out.push({ kind: "removed", text: a[i] ?? "" });
  for (; j < m; j++) out.push({ kind: "added", text: b[j] ?? "" });
  return out;
}

// Long unchanged stretches fold to a line saying how many lines they hide.
export type DiffBlock = { kind: "lines"; lines: DiffLine[] } | { kind: "folded"; count: number };

export function foldDiff(lines: readonly DiffLine[], context = 2): DiffBlock[] {
  const keep = lines.map((l, i) => l.kind !== "same" || lines.slice(Math.max(0, i - context), i + context + 1).some((n) => n.kind !== "same"));
  const blocks: DiffBlock[] = [];
  let run: DiffLine[] = [];
  let folded = 0;
  lines.forEach((line, i) => {
    if (keep[i]) {
      if (folded > 0) {
        blocks.push({ kind: "folded", count: folded });
        folded = 0;
      }
      run.push(line);
    } else {
      if (run.length > 0) {
        blocks.push({ kind: "lines", lines: run });
        run = [];
      }
      folded += 1;
    }
  });
  if (run.length > 0) blocks.push({ kind: "lines", lines: run });
  if (folded > 0) blocks.push({ kind: "folded", count: folded });
  return blocks;
}
