import "server-only";
import { z } from "zod";
import { embedConfig } from "@/env";
import {
  AnswerSource,
  Answer,
  AskStep,
  type Budget,
  QUESTIONS_PAGE_SIZE,
  questionsPage,
  RECENT_QUESTIONS_LOADED,
  RecentQuestionRows,
  SavedAnswer,
  Verdict,
  type AskHome,
  type QuestionsPage,
  type QuestionsQuery,
  type RecentQuestion,
} from "./answers";
import { BudgetRows, CachedOutput, ContextRows, EvidenceRows, ProtocolContextRows, QUESTION_EMBED_TIMEOUT_MS, type AnswerWriter, type AskReads } from "./ask";
import { readTables } from "./chart-store";
import { FileLabelRows, type Label } from "./domain";
import { ExperimentId, PersonId, QuestionId, Sha256, SuggestionId, type LabId, type ProtocolId, type UserId } from "./ids";
import { logError } from "./log";
import { anthropicJsonModel, type JsonModel } from "./json-model";
import { loadProtocolVersion } from "./lab-data";
import { embedQuery, toVectorLiteral, type EmbedOutcome } from "./search";
import {
  OpenSuggestion,
  SuggestionLabelRow,
  SuggestionRow,
  type LabelChange,
  type LabelFacts,
  type Suggestion,
} from "./suggestions";
import { createServiceSupabase, unwrap, type Supabase } from "./supabase/server";

// The database and model behind asking the lab, for the routes and pages. Reads go through
// the member's session; the three writes go through the service role (lib/ask.ts says why).

export type AskSetup = { kind: "ready"; model: JsonModel } | { kind: "unavailable" };

// Without ANTHROPIC_API_KEY asking says it's unavailable instead of failing.
export function askSetup(): AskSetup {
  const key = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  return key === "" ? { kind: "unavailable" } : { kind: "ready", model: anthropicJsonModel(key) };
}

export function askAvailable(): boolean {
  return (process.env.ANTHROPIC_API_KEY?.trim() ?? "") !== "";
}

export function questionEmbedder(): (text: string) => Promise<EmbedOutcome> {
  const config = embedConfig();
  return (text) => embedQuery({ config, text, timeoutMs: QUESTION_EMBED_TIMEOUT_MS });
}

export function memberAskReads(supabase: Supabase, labId: LabId): AskReads {
  return {
    context: async ({ query, embedding, files }) =>
      ContextRows.parse(
        unwrap(
          await supabase.rpc("ask_context", {
            p_lab_id: labId,
            p_query: query,
            p_query_embedding: embedding === null ? null : toVectorLiteral(embedding),
            p_files: files,
            p_chunks: 2,
          }),
        ),
      ),
    protocols: async ({ query, limit }) =>
      ProtocolContextRows.parse(unwrap(await supabase.rpc("ask_protocols", { p_lab_id: labId, p_query: query, p_limit: limit }))),
    table: async (key) => {
      try {
        return await readTables(labId, key);
      } catch {
        return null;
      }
    },
    budget: async () => BudgetRows.parse(unwrap(await supabase.rpc("ai_budget", { p_lab_id: labId }))),
    protocolEvidence: async (protocolId) => EvidenceRows.parse(unwrap(await supabase.rpc("protocol_evidence", { p_protocol_id: protocolId }))),
  };
}

export function serviceAnswerWriter(): AnswerWriter {
  const service = createServiceSupabase();
  return {
    cachedOutput: async (args) => CachedOutput.parse(unwrap(await service.rpc("cached_model_output", args))),
    recordAnswer: async (args) => QuestionId.parse(unwrap(await service.rpc("record_answer", args))),
    recordSuggestion: async (args) => SuggestionId.parse(unwrap(await service.rpc("record_suggestion", args))),
    recordSpend: async (args) => void unwrap(await service.rpc("record_spend", args)),
  };
}

// --- Saved questions ---

const QuestionRow = z.object({
  id: QuestionId,
  question: z.string(),
  outcome: z.enum(["answered", "not_found"]),
  answer: Answer,
  sources: z.array(AnswerSource),
  steps: z.array(AskStep),
  asked_at: z.string(),
});

export async function loadSavedAnswer(supabase: Supabase, labId: LabId, id: QuestionId, userId: string): Promise<SavedAnswer | null> {
  const [rows, feedback] = await Promise.all([
    supabase.from("questions").select("id, question, outcome, answer, sources, steps, asked_at").eq("lab_id", labId).eq("id", id).limit(1),
    supabase.from("answer_feedback").select("verdict").eq("question_id", id).eq("user_id", userId).limit(1),
  ]);
  const row = z.array(QuestionRow).parse(unwrap(rows))[0];
  if (row === undefined) return null;
  const verdict = z.array(z.object({ verdict: Verdict })).parse(unwrap(feedback))[0]?.verdict ?? null;
  return { id: row.id, question: row.question, outcome: row.outcome, answer: row.answer, sources: row.sources, steps: row.steps, askedAt: row.asked_at, myVerdict: verdict };
}

export async function loadRecentQuestions(supabase: Supabase, labId: LabId, limit = 6): Promise<RecentQuestion[]> {
  return RecentQuestionRows.parse(unwrap(await supabase.rpc("recent_questions", { p_lab_id: labId, p_limit: limit })));
}

export async function loadQuestionsPage(supabase: Supabase, labId: LabId, query: QuestionsQuery): Promise<QuestionsPage> {
  const rows = RecentQuestionRows.parse(
    unwrap(
      await supabase.rpc("search_questions", {
        p_lab_id: labId,
        p_query: query.q ?? null,
        p_before_at: query.before?.at ?? null,
        p_before_id: query.before?.id ?? null,
        p_limit: QUESTIONS_PAGE_SIZE + 1,
      }),
    ),
  );
  return questionsPage(rows);
}

export async function loadFileLabels(supabase: Supabase, labId: LabId, shas: readonly Sha256[]): Promise<Map<Sha256, Label>> {
  if (shas.length === 0) return new Map();
  const rows = FileLabelRows.parse(unwrap(await supabase.rpc("file_labels", { p_lab_id: labId, p_shas: shas })));
  return new Map(rows.map((r) => [r.sha256, r.label]));
}

// --- Suggestions ---

const SUGGESTION_COLUMNS =
  "id, kind, state, question_id, requested_by, summary, sources, protocol_id, base_version_id, title, body, note, created_at, decided_by, decided_at, applied_version_id";

export async function loadOpenSuggestions(supabase: Supabase, labId: LabId, protocolId: ProtocolId | null): Promise<OpenSuggestion[]> {
  let query = supabase.from("suggestions").select("id, kind, summary, created_at").eq("lab_id", labId).eq("state", "open");
  if (protocolId !== null) query = query.eq("protocol_id", protocolId);
  const rows = z
    .array(z.object({ id: SuggestionId, kind: z.enum(["protocol_edit", "labels"]), summary: z.string(), created_at: z.string() }))
    .parse(unwrap(await query.order("created_at", { ascending: false }).limit(20)));
  return rows.map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, createdAt: r.created_at }));
}

const NamedRows = z.array(z.object({ id: z.string(), name: z.string() }));

function factsOf(label: Label | null): LabelFacts {
  return {
    cleanName: label?.cleanName ?? null,
    date: label?.date ?? null,
    experiment: label?.experiment?.name ?? null,
    experimentId: label?.experiment?.id ?? null,
    person: label?.person?.name ?? null,
    personId: label?.person?.id ?? null,
  };
}

const CorrectionFacts = z.object({
  clean_name: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  experiment_id: ExperimentId.nullable().default(null),
  person_id: PersonId.nullable().default(null),
});
const CorrectionRows = z.array(z.object({ id: z.number(), before: CorrectionFacts.nullable(), after: CorrectionFacts }));
type Facts = { clean_name: string | null; date: string | null; experiment_id: ExperimentId | null; person_id: PersonId | null };

// What an approval actually changed: the member may have edited the proposal first, so a
// decided change reads its correction, field by field, rather than the proposal.
function appliedFacts(before: Facts | null, after: Facts): Facts {
  const changed = <K extends keyof Facts>(k: K): Facts[K] | null => (before !== null && before[k] === after[k] ? null : after[k]);
  return { clean_name: changed("clean_name"), date: changed("date"), experiment_id: changed("experiment_id"), person_id: changed("person_id") };
}

export async function loadSuggestion(supabase: Supabase, labId: LabId, id: SuggestionId): Promise<Suggestion | null> {
  const row = z
    .array(SuggestionRow)
    .parse(unwrap(await supabase.from("suggestions").select(SUGGESTION_COLUMNS).eq("lab_id", labId).eq("id", id).limit(1)))[0];
  if (row === undefined) return null;
  const common = {
    id: row.id,
    questionId: row.question_id,
    summary: row.summary,
    sources: row.sources,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    decision: { state: row.state, decidedBy: row.decided_by, decidedAt: row.decided_at },
  };
  if (row.kind === "protocol_edit") {
    if (row.protocol_id === null || row.base_version_id === null || row.title === null || row.body === null) return null;
    const [base, current, applied] = await Promise.all([
      supabase.from("protocol_versions").select("version, title, body").eq("id", row.base_version_id).limit(1),
      loadProtocolVersion(supabase, row.protocol_id, null),
      row.applied_version_id === null
        ? Promise.resolve(null)
        : supabase.from("protocol_versions").select("version").eq("id", row.applied_version_id).limit(1),
    ]);
    const before = z.array(z.object({ version: z.number(), title: z.string(), body: z.string() })).parse(unwrap(base))[0];
    if (before === undefined || current === null) return null;
    const appliedVersion = applied === null ? null : (z.array(z.object({ version: z.number() })).parse(unwrap(applied))[0]?.version ?? null);
    return {
      ...common,
      kind: "protocol_edit",
      protocolId: row.protocol_id,
      baseVersionId: row.base_version_id,
      baseVersion: before.version,
      before: { title: before.title, body: before.body },
      draft: { title: row.title, body: row.body, note: row.note },
      stale: row.state === "open" && current.currentVersionId !== row.base_version_id,
      appliedVersion,
    };
  }
  const items = z
    .array(SuggestionLabelRow)
    .parse(
      unwrap(
        await supabase
          .from("suggestion_labels")
          .select("sha256, clean_name, date, experiment_id, person_id, reason, correction_id")
          .eq("suggestion_id", row.id)
          .order("sha256"),
      ),
    );
  const shas = items.map((i) => i.sha256);
  const correctionIds = items.flatMap((i) => (i.correction_id === null ? [] : [i.correction_id]));
  const [labels, experiments, people, paths, corrections] = await Promise.all([
    loadFileLabels(supabase, labId, shas),
    supabase.from("experiments").select("id, name").eq("lab_id", labId).order("name"),
    supabase.from("people").select("id, name:display_name").eq("lab_id", labId).order("display_name"),
    supabase.from("file_locations").select("sha256, path").eq("lab_id", labId).is("deleted_at", null).in("sha256", shas),
    correctionIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : supabase.from("corrections").select("id, before, after").eq("lab_id", labId).in("id", correctionIds),
  ]);
  const experimentList = NamedRows.parse(unwrap(experiments)).map((e) => ({ id: ExperimentId.parse(e.id), name: e.name }));
  const peopleList = NamedRows.parse(unwrap(people)).map((p) => ({ id: PersonId.parse(p.id), name: p.name }));
  const experimentName = new Map<string, string>(experimentList.map((e) => [e.id, e.name]));
  const personName = new Map<string, string>(peopleList.map((p) => [p.id, p.name]));
  const pathOf = new Map(z.array(z.object({ sha256: z.string(), path: z.string() })).parse(unwrap(paths)).map((p) => [p.sha256, p.path]));
  const correctionOf = new Map(CorrectionRows.parse(unwrap(corrections)).map((c) => [c.id, c]));
  const changes = items.map((i): LabelChange => {
    const correction = i.correction_id === null ? undefined : correctionOf.get(i.correction_id);
    const facts: Facts = correction === undefined ? i : appliedFacts(correction.before, correction.after);
    return {
      sha256: i.sha256,
      path: pathOf.get(i.sha256) ?? "",
      current: factsOf(labels.get(i.sha256) ?? null),
      proposed: {
        cleanName: facts.clean_name,
        date: facts.date,
        experiment: facts.experiment_id === null ? null : (experimentName.get(facts.experiment_id) ?? null),
        experimentId: facts.experiment_id,
        person: facts.person_id === null ? null : (personName.get(facts.person_id) ?? null),
        personId: facts.person_id,
      },
      reason: i.reason,
      applied: i.correction_id !== null,
    };
  });
  return { ...common, kind: "labels", changes, lists: { experiments: experimentList, people: peopleList } };
}

// Settings > General's spending line; the page still loads without it.
export async function loadBudget(supabase: Supabase, labId: LabId): Promise<Budget | null> {
  try {
    return BudgetRows.parse(unwrap(await supabase.rpc("ai_budget", { p_lab_id: labId })));
  } catch (error) {
    logError("ask.budget_failed", { labId, error });
    return null;
  }
}

// The Search home's part. It never fails the page, since search works without it.
export async function loadAskHome(supabase: Supabase, labId: LabId, viewerId: UserId): Promise<AskHome> {
  try {
    const [recent, open] = await Promise.all([loadRecentQuestions(supabase, labId, RECENT_QUESTIONS_LOADED), loadOpenSuggestions(supabase, labId, null)]);
    return { available: askAvailable(), recent, openSuggestions: open.length, viewerId };
  } catch (error) {
    logError("ask.home_failed", { labId, error });
    return { available: askAvailable(), recent: [], openSuggestions: 0, viewerId };
  }
}
