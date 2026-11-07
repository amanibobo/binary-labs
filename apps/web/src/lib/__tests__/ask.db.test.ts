import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AskEvent, AskStep } from "../answers";
import { askLab, ContextRows } from "../ask";
import { CreateLabResult, PLAIN_LABEL } from "../domain";
import { ExperimentId, LabId, ProtocolId, ProtocolVersionId, QuestionId, Sha256, SuggestionId, UserId } from "../ids";
import type { ProtocolVersion } from "../protocols";
import { suggestLabels, suggestProtocolEdit } from "../suggest";
import { fakeJsonModel } from "./fake-model";
import { asRole, pgAnswerWriter, pgAskReads, rows, scalar } from "./pg-ask";

vi.mock("server-only", () => ({}));

// Asking the lab and approving suggestions against the real migrations: reads as members
// under RLS, the model's output through the service role, approvals as the member.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ana = UserId.parse("00000000-0000-4000-8000-000000a5a001");
const ben = UserId.parse("00000000-0000-4000-8000-000000a5a002");
const cara = UserId.parse("00000000-0000-4000-8000-000000a5a003");
const notes = Sha256.parse("1f".repeat(32));
const gel = Sha256.parse("2f".repeat(32));
const secret = Sha256.parse("3f".repeat(32));
const member = (userId: UserId) => ({ kind: "member" as const, userId });
const noEmbed = async () => ({ kind: "failed" as const, reason: "embed_unconfigured" as const });

let labA: LabId;
let labB: LabId;
let protocolId: ProtocolId;
let batch3: ExperimentId;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number(z.object({ n: z.coerce.number() }).parse((await db.query(`select count(*) as n from ${sql}`, params)).rows[0]).n);
}

async function sqlError(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return z.object({ code: z.string().optional() }).parse(err).code;
  }
  throw new Error("expected the call to fail");
}

async function addFile(lab: LabId, sha: Sha256, path: string, text: string) {
  const source = z.string().parse((await db.query("select id from sources where lab_id = $1 limit 1", [lab])).rows[0]?.id);
  await db.query("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/plain', 'text') on conflict do nothing", [sha]);
  await db.query(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, $3, $4, $5, 10, '2026-10-14', 'rev', $6, 'indexed')`,
    [lab, source, `id:${sha}`, path, path.split("/").at(-1), sha],
  );
  await db.query("insert into chunks (lab_id, sha256, ord, text) values ($1, $2, 0, $3), ($1, $2, 1, $4)", [lab, sha, path, text]);
}

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'ana@lab.edu'), ($2, 'ben@lab.edu'), ($3, 'cara@other.edu')", [ana, ben, cara]);
  labA = CreateLabResult.parse(await asRole(db, member(ana), async () => scalar(db, "create_lab('Ask Lab')", [])));
  labB = CreateLabResult.parse(await asRole(db, member(cara), async () => scalar(db, "create_lab('Other Lab')", [])));
  await db.query("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [labA, ben]);
  for (const lab of [labA, labB]) await db.query("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/Lab')", [lab]);
  await addFile(labA, notes, "/P450/batch3/notes.txt", "P450 batch 3 yield was 5.2 mg after Ni-NTA. Spun 10 min at 4 C before loading.");
  await addFile(labA, gel, "/P450/batch3/IMG_4821.jpg", "SDS-PAGE gel of P450 batch 3, strong band near 118 kDa.");
  await addFile(labB, secret, "/P450/batch3/secret.txt", "P450 batch 3 yield was 99 mg, only lab B knows.");
  batch3 = ExperimentId.parse((await db.query("insert into experiments (lab_id, name) values ($1, 'P450 batch 3') returning id", [labA])).rows[0]?.id);
  for (const sha of [notes, gel]) {
    await db.query("insert into labels (lab_id, sha256, status, clean_name, confidence, source) values ($1, $2, 'suggested', $3, 0.9, 'rules')", [
      labA,
      sha,
      sha === notes ? "Batch 3 notes" : "Gel photo",
    ]);
  }
  const created = z
    .array(z.object({ protocol_id: ProtocolId }))
    .parse(await asRole(db, member(ana), () => rows(db, "create_protocol($1, 'protocol', 'P450 purification', $2)", [labA, "1. Lyse.\n2. Load on Ni-NTA.\n3. Elute."])));
  protocolId = created[0]?.protocol_id ?? ProtocolId.parse("00000000-0000-4000-8000-000000000000");
});

afterAll(async () => {
  await db.end();
});

const answer = { sentences: [{ text: "Batch 3 yielded 5.2 mg.", citations: [{ source: "F1", cell: null }] }] };

async function ask(question: string, model = fakeJsonModel(() => answer), userId: UserId = ben, lab: LabId = labA) {
  const events: AskEvent[] = [];
  await askLab({ labId: lab, userId, reads: pgAskReads(db, { labId: lab, userId }), writer: pgAnswerWriter(db), model, embed: noEmbed }, question, (e) =>
    events.push(AskEvent.parse(e)),
  );
  return { events, model };
}

describe("retrieval", () => {
  it("stays inside the asking member's lab", async () => {
    const own = ContextRows.parse(await asRole(db, member(ben), () => rows(db, "ask_context($1, 'p450 batch 3 yield', null, 6, 2)", [labA])));
    expect(own.map((r) => r.sha256).sort()).toEqual([notes, gel].sort());
    const other = await asRole(db, member(ben), () => rows(db, "ask_context($1, 'p450 batch 3 yield', null, 6, 2)", [labB]));
    expect(other).toEqual([]);
    const { model } = await ask("What was the yield of P450 batch 3?");
    expect(model.calls[0]?.user).toContain("5.2 mg");
    expect(model.calls[0]?.user).not.toContain("99 mg");
    // The prompt holds only the snippets retrieved, under source ids.
    expect(model.calls[0]?.user).toMatch(/<source id="F1" type="file">/);
  });
});

describe("the ledger, the cache and the cap", () => {
  it("logs one paid call, answers the same question from the cache, and audits each ask", async () => {
    const before = await count("model_calls where lab_id = $1 and purpose::text = 'answer'", [labA]);
    const first = await ask("Which gel shows batch 3?");
    const second = await ask("which gel shows batch 3");
    expect(first.model.calls).toHaveLength(1);
    expect(second.model.calls).toHaveLength(0);
    expect(await count("model_calls where lab_id = $1 and purpose::text = 'answer'", [labA])).toBe(before + 1);
    const done = second.events.at(-1);
    expect(done).toMatchObject({ type: "done", cached: true, costUsd: 0, outcome: "answered" });
    const saved = z
      .array(z.object({ cached: z.boolean(), cost_usd: z.coerce.number(), asked_by: z.string() }))
      .parse((await db.query("select cached, cost_usd, asked_by from questions where lab_id = $1 and question ilike 'which gel%' order by asked_at", [labA])).rows);
    expect(saved).toEqual([
      { cached: false, cost_usd: 0.008, asked_by: ben },
      { cached: true, cost_usd: 0, asked_by: ben },
    ]);
    expect(await count("audit_log where lab_id = $1 and action::text = 'question.ask' and actor = $2", [labA, ben])).toBeGreaterThanOrEqual(2);
  });

  it("saves each answer's steps, which members read back with it", async () => {
    const asked = await ask("Which gel shows batch 3 again?");
    const done = asked.events.at(-1);
    if (done?.type !== "done") throw new Error("expected an answer");
    const steps = await asRole(db, { kind: "member", userId: ben }, async () =>
      z.array(z.object({ steps: z.array(AskStep) })).parse((await db.query("select steps from questions where id = $1", [done.questionId])).rows),
    );
    const saved = steps[0]?.steps ?? [];
    expect(saved[0]).toMatchObject({ kind: "search", query: "Which gel shows batch 3 again?" });
    expect(saved[0]?.kind === "search" && saved[0].found).not.toBeNull();
    expect(saved.at(-1)).toMatchObject({ kind: "write" });
    expect(saved).toEqual(asked.events.flatMap((e) => (e.type === "step" ? [e.step] : [])).slice(1));
  });

  it("stops asking at the lab's monthly cap", async () => {
    await db.query("update labs set ai_monthly_cap_usd = 0.01 where id = $1", [labA]);
    const budget = z.array(z.object({ spent_usd: z.coerce.number() })).parse(await asRole(db, member(ben), () => rows(db, "ai_budget($1)", [labA])));
    expect(budget[0]?.spent_usd).toBeGreaterThanOrEqual(0.01);
    const { events, model } = await ask("What did the batch 3 notes say about spinning?");
    expect(model.calls).toHaveLength(0);
    expect(events.filter((e) => e.type !== "step").map((e) => e.type)).toEqual(["sources", "limit"]);
    await db.query("update labs set ai_monthly_cap_usd = 25 where id = $1", [labA]);
  });

  it("keeps another lab's member out of the budget and the history", async () => {
    expect(await asRole(db, member(cara), () => rows(db, "ai_budget($1)", [labA]))).toEqual([]);
    expect(await asRole(db, member(cara), () => rows(db, "recent_questions($1, 10)", [labA]))).toEqual([]);
    expect(await asRole(db, member(cara), async () => count("questions where lab_id = $1", [labA]))).toBe(0);
  });

  it("saves helpful or not helpful once per member", async () => {
    const id = QuestionId.parse(z.string().parse((await db.query("select id from questions where lab_id = $1 limit 1", [labA])).rows[0]?.id));
    await asRole(db, member(ben), () => db.query("select give_answer_feedback($1, 'helpful')", [id]));
    await asRole(db, member(ben), () => db.query("select give_answer_feedback($1, 'not_helpful')", [id]));
    expect((await db.query("select user_id, verdict from answer_feedback where question_id = $1", [id])).rows).toEqual([{ user_id: ben, verdict: "not_helpful" }]);
    expect(await sqlError(() => asRole(db, member(cara), () => db.query("select give_answer_feedback($1, 'helpful')", [id])))).toBe("22023");
  });
});

describe("what members and the model's output can write", () => {
  it("lets no member write questions, suggestions or the ledger, or call the service functions", async () => {
    const as = (sql: string, params: unknown[]) => sqlError(() => asRole(db, member(ana), () => db.query(sql, params)));
    expect(await as("insert into questions (lab_id, question, outcome, answer, sources) values ($1, 'q', 'answered', '{\"sentences\":[]}', '[]')", [labA])).toBe("42501");
    expect(await as("insert into suggestions (lab_id, kind, summary, model) values ($1, 'labels', 's', 'm')", [labA])).toBe("42501");
    expect(await as("update suggestions set state = 'approved'", [])).toBe("42501");
    expect(await as("insert into model_calls (lab_id, cache_key, purpose, model, prompt_version, output, input_tokens, output_tokens, cost_usd) values ($1, $2, 'label', 'm', 1, '{}', 0, 0, 0)", [labA, "a".repeat(64)])).toBe("42501");
    expect(await as("select record_answer($1, $2, 'q', 'answered', '{\"sentences\":[]}', '[]', 0, 0, null, false, 0, null)", [labA, ana])).toBe("42501");
    expect(await as("select cached_model_output($1, 'answer', $2, 'm', 1)", [labA, "a".repeat(64)])).toBe("42501");
  });

  it("keeps the service functions to members of the lab named", async () => {
    const code = await sqlError(() =>
      pgAnswerWriter(db).recordAnswer({
        p_lab_id: labA,
        p_user_id: cara,
        p_question: "q?",
        p_outcome: "not_found",
        p_answer: { sentences: [] },
        p_sources: [],
        p_dropped_citations: 0,
        p_dropped_sentences: 0,
        p_model: null,
        p_cached: false,
        p_latency_ms: 0,
        p_call: null,
        p_steps: [],
      }),
    );
    expect(code).toBe("42501");
  });
});

async function currentProtocol(): Promise<ProtocolVersion> {
  const [row] = z
    .array(z.object({ version_id: ProtocolVersionId, version: z.number(), title: z.string(), body: z.string(), current_version_id: ProtocolVersionId }))
    .length(1)
    .parse(await asRole(db, member(ben), () => rows(db, "protocol_version($1, null)", [protocolId])));
  if (row === undefined) throw new Error("no protocol");
  return {
    protocolId,
    kind: "protocol",
    archived: false,
    currentVersionId: row.current_version_id,
    currentVersion: row.version,
    id: row.version_id,
    version: row.version,
    title: row.title,
    body: row.body,
    note: null,
    author: ana,
    createdAt: "2026-11-05T00:00:00Z",
  };
}

const editReply = (body: string) => ({
  changed: true,
  summary: "Adds the 10 min spin the batch 3 notes do before loading.",
  note: "Spin before loading",
  title: "P450 purification",
  body,
  sources: ["F1", "F7"],
});

async function draftEdit(body = "1. Lyse.\n2. Spin 10 min at 4 C.\n3. Load on Ni-NTA.\n4. Elute.") {
  const protocol = await currentProtocol();
  const drafted = await suggestProtocolEdit(
    { labId: labA, userId: ben, reads: pgAskReads(db, { labId: labA, userId: ben }), writer: pgAnswerWriter(db), model: fakeJsonModel(() => editReply(body)), embed: noEmbed },
    { protocol, questionId: null, question: `spin ${Math.random()}` },
  );
  if (drafted.kind !== "created") throw new Error(`expected a draft, got ${drafted.kind}`);
  return { id: drafted.id, protocol };
}

const versions = () => count("protocol_versions where protocol_id = $1", [protocolId]);

describe("protocol edit suggestions", () => {
  it("drafts on a fork without touching the protocol, citing only real sources", async () => {
    const before = await versions();
    const { id, protocol } = await draftEdit();
    expect(await versions()).toBe(before);
    const row = z
      .object({ state: z.string(), base_version_id: z.string(), sources: z.array(z.object({ key: z.string() })) })
      .parse((await db.query("select state, base_version_id, sources from suggestions where id = $1", [id])).rows[0]);
    expect(row).toEqual({ state: "open", base_version_id: protocol.id, sources: [expect.objectContaining({ key: "F1" })] });
    expect(await count("audit_log where action::text = 'suggestion.create' and target = $1", [id])).toBe(1);
    expect(await count("model_calls where lab_id = $1 and purpose::text = 'suggestion'", [labA])).toBeGreaterThanOrEqual(1);
  });

  it("can't be approved by settling it directly, only by saving the version", async () => {
    const { id } = await draftEdit();
    expect(await sqlError(() => asRole(db, member(ben), () => db.query("select settle_suggestion($1, null, false, null)", [id])))).toBe("42501");
    expect(await sqlError(() => asRole(db, member(cara), () => db.query("select approve_protocol_suggestion($1)", [id])))).toBe("BL601");
  });

  it("approving saves the next version as the approver, through the normal path", async () => {
    const { id, protocol } = await draftEdit();
    const saved = z
      .array(z.object({ version: z.number() }))
      .parse(await asRole(db, member(ana), () => rows(db, "approve_protocol_suggestion($1)", [id])));
    expect(saved[0]?.version).toBe(protocol.version + 1);
    const version = (await db.query("select author, body, based_on from protocol_versions where protocol_id = $1 and version = $2", [protocolId, protocol.version + 1])).rows[0];
    expect(version).toMatchObject({ author: ana, based_on: protocol.id, body: expect.stringContaining("Spin 10 min") });
    expect((await db.query("select state, decided_by, edited from suggestions where id = $1", [id])).rows[0]).toEqual({ state: "approved", decided_by: ana, edited: false });
    expect(await count("audit_log where action::text = 'suggestion.approve' and target = $1 and actor = $2", [id, ana])).toBe(1);
    expect(await count("audit_log where action::text = 'protocol.save' and target = $1 and actor = $2", [protocolId, ana])).toBeGreaterThanOrEqual(1);
    expect(await sqlError(() => asRole(db, member(ben), () => db.query("select approve_protocol_suggestion($1)", [id])))).toBe("BL601");
  });

  it("approving after edits saves the member's text and marks it edited", async () => {
    const { id } = await draftEdit("1. Lyse.\n2. Spin.\n3. Load.");
    await asRole(db, member(ben), () => rows(db, "approve_protocol_suggestion($1, null, $2, 'Spin, reworded')", [id, "1. Lyse.\n2. Spin 10 min, 4 C.\n3. Load."]));
    const current = await currentProtocol();
    expect(current.body).toBe("1. Lyse.\n2. Spin 10 min, 4 C.\n3. Load.");
    expect((await db.query("select edited, decided_by from suggestions where id = $1", [id])).rows[0]).toEqual({ edited: true, decided_by: ben });
  });

  it("a save since the draft stops the approval, and the suggestion stays open", async () => {
    const { id, protocol } = await draftEdit();
    await asRole(db, member(ana), () => rows(db, "save_protocol($1, $2, 'P450 purification', 'Someone else edited.')", [protocolId, protocol.id]));
    expect(await sqlError(() => asRole(db, member(ben), () => db.query("select approve_protocol_suggestion($1)", [id])))).toBe("BL101");
    expect((await db.query("select state from suggestions where id = $1", [id])).rows[0]).toEqual({ state: "open" });
  });

  it("dismissing changes nothing and is audited", async () => {
    const before = await versions();
    const { id } = await draftEdit();
    await asRole(db, member(ben), () => db.query("select dismiss_suggestion($1)", [id]));
    expect(await versions()).toBe(before);
    expect((await db.query("select state, decided_by from suggestions where id = $1", [id])).rows[0]).toEqual({ state: "dismissed", decided_by: ben });
    expect(await count("audit_log where action::text = 'suggestion.dismiss' and target = $1 and actor = $2", [id, ben])).toBe(1);
    expect(await sqlError(() => asRole(db, member(ben), () => db.query("select dismiss_suggestion($1)", [id])))).toBe("BL601");
  });
});

describe("label suggestions", () => {
  async function draftLabels(): Promise<SuggestionId> {
    const { events } = await ask(`What files are from batch 3? ${Math.random()}`);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected an answer");
    const sources = events.find((e) => e.type === "sources");
    if (sources?.type !== "sources") throw new Error("expected sources");
    const labels = new Map(
      [notes, gel].map((sha) => [sha, { ...PLAIN_LABEL, status: "suggested" as const, cleanName: sha === notes ? "Batch 3 notes" : "Gel photo", date: null, experiment: null, person: null, instrument: null, tags: [], confidence: 0.9 }]),
    );
    const keyOf = (sha: Sha256) => sources.sources.find((s) => s.kind === "file" && s.sha256 === sha)?.key ?? "F9";
    const drafted = await suggestLabels(
      {
        labId: labA,
        userId: ben,
        reads: pgAskReads(db, { labId: labA, userId: ben }),
        writer: pgAnswerWriter(db),
        embed: noEmbed,
        model: fakeJsonModel(() => ({
          summary: "These 2 files look like batch 3.",
          changes: [
            { file: keyOf(notes), name: null, date: null, experiment: "P450 batch 3", person: null, reason: "It sits in the batch3 folder." },
            { file: keyOf(gel), name: null, date: "2026-10-14", experiment: "p450 batch 3", person: null, reason: "Its caption says batch 3." },
            { file: "F9", name: "Invented", date: null, experiment: "P450 batch 3", person: null, reason: "Not a file it was shown." },
            { file: keyOf(notes), name: null, date: null, experiment: "Batch 99", person: null, reason: "A second change to the same file." },
          ],
        })),
      },
      {
        asked: { id: done.questionId, question: "What files are from batch 3?", outcome: done.outcome, answer: done.answer, sources: sources.sources, steps: [], askedAt: "2026-11-05T00:00:00Z", myVerdict: null },
        labels,
        lists: { experiments: [{ id: batch3, name: "P450 batch 3", aliases: [] }], people: [] },
      },
    );
    if (drafted.kind !== "created") throw new Error(`expected a draft, got ${drafted.kind}`);
    return drafted.id;
  }

  it("lists checked changes without changing any label", async () => {
    const id = await draftLabels();
    expect((await db.query("select sha256, experiment_id, date from suggestion_labels where suggestion_id = $1 order by sha256", [id])).rows).toEqual([
      { sha256: notes, experiment_id: batch3, date: null },
      { sha256: gel, experiment_id: batch3, date: expect.any(Date) },
    ].sort((a, b) => a.sha256.localeCompare(b.sha256)));
    expect(await count("labels where lab_id = $1 and experiment_id is not null", [labA])).toBe(0);
    expect(await count("corrections where lab_id = $1", [labA])).toBe(0);
  });

  it("applies only the chosen files, as corrections by the approver", async () => {
    const id = await draftLabels();
    const applied = await asRole(db, member(ana), () => rows(db, "approve_label_suggestion($1, $2)", [id, [notes]]));
    expect(applied).toEqual([{ sha256: notes, correction_id: expect.any(Number) }]);
    expect((await db.query("select experiment_id, source from labels where lab_id = $1 and sha256 = $2", [labA, notes])).rows[0]).toEqual({ experiment_id: batch3, source: "human" });
    expect((await db.query("select experiment_id from labels where lab_id = $1 and sha256 = $2", [labA, gel])).rows[0]).toEqual({ experiment_id: null });
    expect((await db.query("select user_id from corrections where lab_id = $1", [labA])).rows).toEqual([{ user_id: ana }]);
    expect((await db.query("select state, edited from suggestions where id = $1", [id])).rows[0]).toEqual({ state: "approved", edited: true });
    expect(await count("audit_log where action::text = 'suggestion.approve' and target = $1", [id])).toBe(1);
  });

  it("refuses files that aren't in the suggestion", async () => {
    const id = await draftLabels();
    expect(await sqlError(() => asRole(db, member(ana), () => db.query("select * from approve_label_suggestion($1, $2)", [id, [secret]])))).toBe("BL602");
    expect(await sqlError(() => asRole(db, member(ana), () => db.query("select settle_suggestion($1, null, false, $2::jsonb)", [id, JSON.stringify([{ sha256: gel, correction_id: 1 }])])))).toBe("42501");
  });
});
