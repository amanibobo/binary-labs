import type { Client } from "pg";
import { z } from "zod";
import { BudgetRows, CachedOutput, ContextRows, ProtocolContextRows, type AnswerWriter, type AskReads } from "../ask";
import type { DataTables } from "../data-tables";
import { QuestionId, SuggestionId, type LabId, type UserId } from "../ids";
import { toVectorLiteral } from "../search";

// Asking the lab on plain Postgres, for db tests and the eval: reads run as the member under
// RLS (the authenticated role with their JWT claims), writes as the service role, the way
// supabase-js calls them, with rows serialized by to_jsonb as PostgREST does.

export async function asRole<T>(db: Client, role: { kind: "member"; userId: string } | { kind: "service" }, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    if (role.kind === "member") {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: role.userId })]);
    } else {
      await db.query("set local role service_role");
    }
    const out = await fn();
    await db.query("commit");
    return out;
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
}

export async function rows(db: Client, sql: string, params: unknown[]): Promise<unknown> {
  const res = await db.query(`select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as rows from ${sql} r`, params);
  return z.object({ rows: z.unknown() }).parse(res.rows[0]).rows;
}

export async function scalar(db: Client, sql: string, params: unknown[]): Promise<unknown> {
  const res = await db.query(`select ${sql} as v`, params);
  return z.object({ v: z.unknown() }).parse(res.rows[0]).v;
}

export function pgAskReads(
  db: Client,
  { labId, userId, tables = () => null }: { labId: LabId; userId: UserId; tables?: (key: string) => DataTables | null },
): AskReads {
  const member = { kind: "member" as const, userId };
  return {
    context: ({ query, embedding, files }) =>
      asRole(db, member, async () =>
        ContextRows.parse(
          await rows(db, "ask_context($1, $2, $3::vector, $4, 2)", [labId, query, embedding === null ? null : toVectorLiteral(embedding), files]),
        ),
      ),
    protocols: ({ query, limit }) => asRole(db, member, async () => ProtocolContextRows.parse(await rows(db, "ask_protocols($1, $2, $3)", [labId, query, limit]))),
    table: async (key) => tables(key),
    budget: () => asRole(db, member, async () => BudgetRows.parse(await rows(db, "ai_budget($1)", [labId]))),
  };
}

const json = (v: unknown) => (v === null ? null : JSON.stringify(v));

export function pgAnswerWriter(db: Client): AnswerWriter {
  const service = { kind: "service" as const };
  return {
    cachedOutput: (a) =>
      asRole(db, service, async () =>
        CachedOutput.parse(await scalar(db, "cached_model_output($1, $2, $3, $4, $5)", [a.p_lab_id, a.p_purpose, a.p_cache_key, a.p_model, a.p_prompt_version])),
      ),
    recordAnswer: (a) =>
      asRole(db, service, async () =>
        QuestionId.parse(
          await scalar(db, "record_answer($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb)", [
            a.p_lab_id,
            a.p_user_id,
            a.p_question,
            a.p_outcome,
            json(a.p_answer),
            json(a.p_sources),
            a.p_dropped_citations,
            a.p_dropped_sentences,
            a.p_model,
            a.p_cached,
            a.p_latency_ms,
            json(a.p_call),
          ]),
        ),
      ),
    recordSuggestion: (a) =>
      asRole(db, service, async () =>
        SuggestionId.parse(
          await scalar(db, "record_suggestion($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb)", [
            a.p_lab_id,
            a.p_user_id,
            a.p_kind,
            a.p_question_id,
            a.p_summary,
            json(a.p_sources),
            a.p_protocol_id,
            a.p_base_version_id,
            a.p_title,
            a.p_body,
            a.p_note,
            json(a.p_labels),
            a.p_model,
            json(a.p_call),
          ]),
        ),
      ),
    recordSpend: (a) => asRole(db, service, async () => void (await scalar(db, "record_spend($1, $2, $3, $4::jsonb)", [a.p_lab_id, a.p_user_id, a.p_purpose, json(a.p_call)]))),
  };
}
