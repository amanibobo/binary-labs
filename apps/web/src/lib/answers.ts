import { z } from "zod";
import { FileKind, SourceKind, type FileLocation } from "./domain";
import { LocationId, ProtocolId, ProtocolVersionId, QuestionId, Sha256, SourceId, UserId } from "./ids";
import { ProtocolKind } from "./protocols";

// Asking the lab: what an answer is made of, how the model's reply is checked before anyone
// sees it, and the stream of events the Search page reads. Shared by the route and the page.

// What the model is shown is labeled F1, F2… for files and P1, P2… for protocols; a citation
// names one of these, and only these.
export const SourceKey = z.string().regex(/^[FP][1-9][0-9]?$/, "expected a source like F1 or P2");
export type SourceKey = z.infer<typeof SourceKey>;

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");

// The part of a file's parsed table the model saw, so a cell it cites can be checked and shown.
export const TableExcerpt = z.object({
  name: z.string(),
  columns: z.array(z.object({ id: z.string(), label: z.string() })),
  // Rows 1..rows were shown.
  rows: z.number().int().nonnegative(),
});
export type TableExcerpt = z.infer<typeof TableExcerpt>;

const FileLocationWire = z.object({
  id: LocationId,
  sourceId: SourceId,
  sourceKind: SourceKind,
  path: z.string(),
  originalName: z.string(),
  modifiedAt: Timestamp,
}) satisfies z.ZodType<FileLocation>;

export const FileSource = z.object({
  kind: z.literal("file"),
  key: SourceKey,
  sha256: Sha256,
  fileKind: FileKind,
  name: z.string(),
  location: FileLocationWire,
  // The text the model read, as shown under the answer.
  excerpts: z.array(z.string()),
  tables: z.array(TableExcerpt),
});
export type FileSource = z.infer<typeof FileSource>;

export const ProtocolSource = z.object({
  kind: z.literal("protocol"),
  key: SourceKey,
  protocolId: ProtocolId,
  versionId: ProtocolVersionId,
  version: z.number().int().positive(),
  protocolKind: ProtocolKind,
  title: z.string(),
});
export type ProtocolSource = z.infer<typeof ProtocolSource>;

export const AnswerSource = z.discriminatedUnion("kind", [FileSource, ProtocolSource]);
export type AnswerSource = z.infer<typeof AnswerSource>;

// One cell of a parsed table, resolved from what the model cited ("Kinetics!C4").
export const CellRef = z.object({ table: z.string(), column: z.string(), row: z.number().int().positive(), value: z.string() });
export type CellRef = z.infer<typeof CellRef>;

export const Citation = z.object({ source: SourceKey, cell: CellRef.nullable() });
export type Citation = z.infer<typeof Citation>;

// A sentence always has a citation: one without any is never shown.
export const AnswerSentence = z.object({ text: z.string().min(1), citations: z.tuple([Citation], Citation) });
export type AnswerSentence = z.infer<typeof AnswerSentence>;

export const Answer = z.object({ sentences: z.array(AnswerSentence) });
export type Answer = z.infer<typeof Answer>;

export const AnswerOutcome = z.enum(["answered", "not_found"]);
export type AnswerOutcome = z.infer<typeof AnswerOutcome>;

export const Verdict = z.enum(["helpful", "not_helpful"]);
export type Verdict = z.infer<typeof Verdict>;

export const QUESTION_MAX = 300;
export const AskRequest = z.object({ question: z.string().trim().min(3).max(QUESTION_MAX) });

// --- What the model returns (structured output) and how it's checked ---

// The JSON schema the model is held to. Hand-written so it stays exactly what the API accepts.
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      description: "The answer, one claim per sentence, each citing where it came from. Empty when the sources don't answer the question.",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          citations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source: { type: "string", description: "A source id from the list, like F1 or P2." },
                cell: { type: ["string", "null"], description: "For a table, the cell as Table!C4; otherwise null." },
              },
              required: ["source", "cell"],
              additionalProperties: false,
            },
          },
        },
        required: ["text", "citations"],
        additionalProperties: false,
      },
    },
  },
  required: ["sentences"],
  additionalProperties: false,
} as const;

// Loose on purpose: anything the model wrote that isn't this shape counts as no answer, and the
// ids in it are checked against the sources next.
const RawCitation = z.object({ source: z.string(), cell: z.string().nullable().optional() });
export const RawSentence = z.object({ text: z.string(), citations: z.array(RawCitation) });
export type RawSentence = z.infer<typeof RawSentence>;
export const RawAnswer = z.object({ sentences: z.array(RawSentence) });
export type RawAnswer = z.infer<typeof RawAnswer>;

// What a source looks like to the checker: its key and, for a file, the cells it was shown.
export type ShownSource = { key: SourceKey; cells: ReadonlyMap<string, CellRef> };

export type CheckedSentence = { kind: "kept"; sentence: AnswerSentence; dropped: number } | { kind: "uncited"; dropped: number };

// A citation survives only if it names a source the model was shown. A cell it names must be
// one the model was shown too; a made-up cell leaves the file citation standing without it.
export function checkSentence(raw: RawSentence, shown: ReadonlyMap<string, ShownSource>): CheckedSentence {
  const kept: Citation[] = [];
  let dropped = 0;
  for (const c of raw.citations) {
    const source = shown.get(c.source.trim().toUpperCase());
    if (source === undefined) {
      dropped += 1;
      continue;
    }
    const cell = c.cell == null ? null : (source.cells.get(normalizeCell(c.cell)) ?? null);
    if (kept.some((k) => k.source === source.key && sameCell(k.cell, cell))) continue;
    kept.push({ source: source.key, cell });
  }
  const text = raw.text.trim();
  const [first, ...rest] = kept;
  if (first === undefined || text === "") return { kind: "uncited", dropped };
  return { kind: "kept", sentence: { text, citations: [first, ...rest] }, dropped };
}

function sameCell(a: CellRef | null, b: CellRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.table === b.table && a.column === b.column && a.row === b.row;
}

export type CheckedAnswer = { answer: Answer; outcome: AnswerOutcome; droppedCitations: number; droppedSentences: number };

export function checkAnswer(raw: RawAnswer, shown: ReadonlyMap<string, ShownSource>): CheckedAnswer {
  const sentences: AnswerSentence[] = [];
  let droppedCitations = 0;
  let droppedSentences = 0;
  for (const r of raw.sentences) {
    const checked = checkSentence(r, shown);
    droppedCitations += checked.dropped;
    if (checked.kind === "kept") sentences.push(checked.sentence);
    else droppedSentences += 1;
  }
  return { answer: { sentences }, outcome: sentences.length > 0 ? "answered" : "not_found", droppedCitations, droppedSentences };
}

// "Kinetics!c4", "kinetics ! C4" and "Kinetics!C04" are one cell.
export function normalizeCell(cell: string): string {
  const m = /^(.*)!\s*([A-Za-z]{1,3})0*([1-9][0-9]*)$/.exec(cell.trim());
  if (m === null) return cell.trim().toLowerCase();
  return `${(m[1] ?? "").trim().toLowerCase()}!${(m[2] ?? "").toUpperCase()}${m[3] ?? ""}`;
}

// --- Reading the model's JSON as it streams ---

// The model writes {"sentences":[{…},{…}]}. This hands back each sentence object as soon as its
// closing brace arrives, so the page can show it (checked) before the reply is finished.
export class SentenceStream {
  private text = "";
  private pos = 0;
  private inArray = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private start = -1;
  private done = false;

  push(delta: string): RawSentence[] {
    this.text += delta;
    const out: RawSentence[] = [];
    if (this.done) return out;
    if (!this.inArray) {
      const m = /"sentences"\s*:\s*\[/.exec(this.text);
      if (m === null) return out;
      this.inArray = true;
      this.pos = m.index + m[0].length;
    }
    for (; this.pos < this.text.length; this.pos++) {
      const ch = this.text[this.pos];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === "\\") this.escaped = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') this.inString = true;
      else if (ch === "{") {
        if (this.depth === 0) this.start = this.pos;
        this.depth += 1;
      } else if (ch === "}") {
        this.depth -= 1;
        if (this.depth === 0 && this.start >= 0) {
          const parsed = RawSentence.safeParse(safeJson(this.text.slice(this.start, this.pos + 1)));
          if (parsed.success) out.push(parsed.data);
          this.start = -1;
        }
      } else if (ch === "]" && this.depth === 0) {
        this.done = true;
        break;
      }
    }
    return out;
  }
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// --- Events the ask route streams, one JSON object per line ---

export const Budget = z.object({ capUsd: z.number(), spentUsd: z.number(), resetsAt: Timestamp });
export type Budget = z.infer<typeof Budget>;

export const AskEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sources"), sources: z.array(AnswerSource) }),
  z.object({ type: z.literal("sentence"), sentence: AnswerSentence }),
  // The lab spent its month's allowance; the sources are still the closest files.
  z.object({ type: z.literal("limit"), budget: Budget }),
  z.object({
    type: z.literal("done"),
    questionId: QuestionId,
    outcome: AnswerOutcome,
    answer: Answer,
    cached: z.boolean(),
    costUsd: z.number(),
    latencyMs: z.number(),
  }),
  z.object({ type: z.literal("failed"), message: z.string() }),
]);
export type AskEvent = z.infer<typeof AskEvent>;

// --- A saved question, as history and as an answer opened again ---

export const SavedAnswer = z.object({
  id: QuestionId,
  question: z.string(),
  outcome: AnswerOutcome,
  answer: Answer,
  sources: z.array(AnswerSource),
  askedAt: Timestamp,
  myVerdict: Verdict.nullable(),
});
export type SavedAnswer = z.infer<typeof SavedAnswer>;

export const RecentQuestion = z.object({
  id: QuestionId,
  question: z.string(),
  outcome: AnswerOutcome,
  askedBy: UserId.nullable(),
  askedByEmail: z.string().nullable(),
  askedAt: Timestamp,
});
export type RecentQuestion = z.infer<typeof RecentQuestion>;

export const RecentQuestionRows = z.array(
  z
    .object({
      id: QuestionId,
      question: z.string(),
      outcome: AnswerOutcome,
      asked_by: UserId.nullable(),
      asked_by_email: z.string().nullable(),
      asked_at: Timestamp,
    })
    .transform(
      (r): RecentQuestion => ({ id: r.id, question: r.question, outcome: r.outcome, askedBy: r.asked_by, askedByEmail: r.asked_by_email, askedAt: r.asked_at }),
    ),
);

// What the Search page needs to ask: whether a model is set up, the lab's recent questions
// and how many suggestions wait for someone.
export type AskHome = {
  available: boolean;
  recent: RecentQuestion[];
  openSuggestions: number;
  viewerId: UserId | null;
};

// --- How the page shows things ---

// A question reads like a question when it asks one; plain searches stay plain searches.
const QUESTION_WORDS = /^(what|which|when|where|who|whose|why|how|did|do|does|is|are|was|were|has|have|can|could|should|list|show|find me|tell me)\b/i;
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return false;
  return t.endsWith("?") || (QUESTION_WORDS.test(t) && t.split(/\s+/).length >= 4);
}

export function cellLabel(cell: CellRef): string {
  return `${cell.table}, ${cell.column}, row ${cell.row}`;
}

// The number a citation shows: its source's place in the list, from 1.
export function sourceNumber(sources: readonly AnswerSource[], key: SourceKey): number | null {
  const i = sources.findIndex((s) => s.key === key);
  return i < 0 ? null : i + 1;
}

// The sources a finished answer leans on, in the order they're listed.
export function citedSources(sources: readonly AnswerSource[], answer: Answer): AnswerSource[] {
  const cited = new Set(answer.sentences.flatMap((s) => s.citations.map((c) => c.source)));
  return sources.filter((s) => cited.has(s.key));
}
