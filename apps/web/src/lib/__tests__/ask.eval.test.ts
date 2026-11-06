import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AskEvent, citedSources, type AnswerSource } from "../answers";
import { askLab } from "../ask";
import { DataTables } from "../data-tables";
import { LabId, UserId } from "../ids";
import { anthropicJsonModel } from "../json-model";
import { embedQuery } from "../search";
import { pgAnswerWriter, pgAskReads } from "./pg-ask";

// The ask eval, driven by scripts/eval-ask.sh: the sample lab built by the real worker, real
// query embeddings from /embed and the real model. Skipped in the normal unit run.
const env = z
  .object({
    EVAL_DATABASE_URL: z.string(),
    EVAL_STORE: z.string(),
    EVAL_OUT: z.string(),
    EMBED_URL: z.string(),
    EMBED_API_KEY: z.string(),
    ANTHROPIC_API_KEY: z.string().min(1),
  })
  .safeParse(process.env);

const Expected = z.object({ questions: z.array(z.object({ q: z.string(), expect: z.array(z.string()).nullable() })) });

function matches(source: AnswerSource, wanted: string): boolean {
  if (wanted.startsWith("protocol:")) return source.kind === "protocol" && source.title.toLowerCase().startsWith(wanted.slice(9).toLowerCase());
  return source.kind === "file" && source.location.path.toLowerCase().endsWith(wanted.toLowerCase());
}

describe.skipIf(!env.success)("asking the sample lab", () => {
  it("answers with the right sources", { timeout: 15 * 60_000 }, async () => {
    if (!env.success) return;
    const e = env.data;
    const expected = Expected.parse(JSON.parse(readFileSync(join(import.meta.dirname, "../../../../../workers/evals/ask_expected.json"), "utf8")));
    const db = new Client({ connectionString: e.EVAL_DATABASE_URL });
    await db.connect();
    const who = z.object({ lab_id: LabId, user_id: UserId }).parse((await db.query("select lab_id, user_id from members where role = 'admin' limit 1")).rows[0]);
    const tables = (key: string) => {
      try {
        return DataTables.parse(JSON.parse(readFileSync(join(e.EVAL_STORE, key), "utf8")));
      } catch {
        return null;
      }
    };
    const deps = {
      labId: who.lab_id,
      userId: who.user_id,
      reads: pgAskReads(db, { labId: who.lab_id, userId: who.user_id, tables }),
      writer: pgAnswerWriter(db),
      model: anthropicJsonModel(e.ANTHROPIC_API_KEY),
      embed: (text: string) => embedQuery({ config: { kind: "configured", url: e.EMBED_URL, apiKey: e.EMBED_API_KEY }, text, timeoutMs: 2000 }),
    };

    const results = [];
    for (const item of expected.questions) {
      const events: AskEvent[] = [];
      const started = performance.now();
      let firstSentenceMs: number | null = null;
      await askLab(deps, item.q, (ev) => {
        if (ev.type === "sentence" && firstSentenceMs === null) firstSentenceMs = performance.now() - started;
        events.push(ev);
      });
      const latencyMs = performance.now() - started;
      const sources = events.flatMap((ev) => (ev.type === "sources" ? ev.sources : []));
      const done = events.find((ev) => ev.type === "done");
      if (done?.type !== "done") throw new Error(`no answer for ${item.q}: ${JSON.stringify(events.at(-1))}`);
      const saved = z
        .object({ dropped_citations: z.number(), dropped_sentences: z.number(), cost_usd: z.coerce.number() })
        .parse((await db.query("select dropped_citations, dropped_sentences, cost_usd from questions where id = $1", [done.questionId])).rows[0]);
      const cited = citedSources(sources, done.answer);
      const wanted = item.expect;
      results.push({
        question: item.q,
        answerable: wanted !== null,
        outcome: done.outcome,
        answer: done.answer.sentences.map((s) => s.text).join(" "),
        cited: cited.map((s) => (s.kind === "file" ? s.location.path : `protocol:${s.title}`)),
        cells: done.answer.sentences.flatMap((s) => s.citations.flatMap((c) => (c.cell === null ? [] : [`${c.cell.table}!${c.cell.column}#${c.cell.row}=${c.cell.value}`]))),
        retrievedRight: wanted === null ? null : sources.some((s) => wanted.some((w) => matches(s, w))),
        citedRight: wanted === null ? done.outcome === "not_found" : cited.some((s) => wanted.some((w) => matches(s, w))),
        sentences: done.answer.sentences.length,
        droppedCitations: saved.dropped_citations,
        droppedSentences: saved.dropped_sentences,
        latencyMs: Math.round(latencyMs),
        firstSentenceMs: firstSentenceMs === null ? null : Math.round(firstSentenceMs),
        costUsd: saved.cost_usd,
      });
    }
    await db.end();

    const answerable = results.filter((r) => r.answerable);
    const unanswerable = results.filter((r) => !r.answerable);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const summary = {
      questions: results.length,
      answerableCitedRight: `${answerable.filter((r) => r.citedRight).length}/${answerable.length}`,
      answerableRetrievedRight: `${answerable.filter((r) => r.retrievedRight).length}/${answerable.length}`,
      noAnswerSaidSo: `${unanswerable.filter((r) => r.citedRight).length}/${unanswerable.length}`,
      sentencesShown: sum(results.map((r) => r.sentences)),
      unsupportedSentencesDropped: sum(results.map((r) => r.droppedSentences)),
      inventedCitationsDropped: sum(results.map((r) => r.droppedCitations)),
      avgLatencyMs: Math.round(sum(results.map((r) => r.latencyMs)) / results.length),
      avgFirstSentenceMs: Math.round(sum(results.flatMap((r) => (r.firstSentenceMs === null ? [] : [r.firstSentenceMs]))) / Math.max(1, results.filter((r) => r.firstSentenceMs !== null).length)),
      avgCostUsd: Number((sum(results.map((r) => r.costUsd)) / results.length).toFixed(5)),
      totalCostUsd: Number(sum(results.map((r) => r.costUsd)).toFixed(5)),
    };
    writeFileSync(e.EVAL_OUT, JSON.stringify({ summary, results }, null, 2));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    expect(results).toHaveLength(expected.questions.length);
  });
});
