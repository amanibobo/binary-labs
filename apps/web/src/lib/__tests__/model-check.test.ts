import { describe, expect, it } from "vitest";
import { fixtureModelChecks } from "@/fixtures/runs-model-check";
import { AnswerId, answerMark, costLine, headline, headlineNote, keepOffered, missedLine, ModelCheckRequest, modelCheckFailure, modelName, RunModelChecksJson, tally, type ModelAnswer } from "../model-check";

const base: ModelAnswer = {
  id: AnswerId.parse("7d1c2c39-5a4e-4c55-9d7b-0c3c1a7e0101"),
  model: "anthropic/claude-opus-5.5",
  state: "answered",
  answer: "The buffer pH.",
  verdict: "solved",
  reason: "Same cause.",
  solved: true,
  error: null,
  costUsd: 0.05,
  judgedBy: null,
  judgedNote: null,
  judgedAt: null,
};
const a = (over: Partial<ModelAnswer>): ModelAnswer => ({ ...base, ...over });

describe("tally and its lines", () => {
  it("counts only the models that answered toward 'of N', and says what is still open", () => {
    const answers = [
      a({}),
      a({ model: "openai/gpt-6.2-astra", verdict: "not_solved", solved: false }),
      a({ model: "google/gemini-4-neon", verdict: "partial", solved: null }),
      a({ model: "x-ai/grok-4.7", state: "skipped", answer: null, verdict: null, solved: null, error: "cost_cap" }),
    ];
    const t = tally(answers);
    expect(t).toEqual({ answered: 3, solved: 1, notSolved: 1, toJudge: 1, waiting: 0, missed: 1 });
    expect(headline(t)).toBe("Solved by 1 of 3 models");
    expect(headlineNote(t)).toBe("1 answer needs a second scientist to judge it against the rubric. 1 model didn't answer.");
    expect(keepOffered(t)).toBe(false);
  });

  it("offers to keep a task only once every answer is settled and most models failed it", () => {
    const failedBy = (n: number) => [a({}), ...Array.from({ length: n }, (_, i) => a({ model: `m/${i}`, verdict: "not_solved", solved: false }))];
    expect(keepOffered(tally(failedBy(3)))).toBe(true);
    expect(keepOffered(tally(failedBy(1)))).toBe(false);
    expect(keepOffered(tally([...failedBy(3), a({ model: "m/w", state: "waiting", answer: null, verdict: null, solved: null })]))).toBe(false);
    expect(keepOffered(tally([]))).toBe(false);
  });

  it("says how far a running check has got", () => {
    expect(headline(tally([a({}), a({ model: "m/2", state: "waiting", answer: null, verdict: null, solved: null })]))).toBe("1 of 2 models have answered so far");
    expect(headline(tally([a({ state: "failed", answer: null, verdict: null, solved: null, error: "HTTP 503" })]))).toBe("No model answered");
  });
});

describe("a model's row", () => {
  it("says on whose word an answer solved it", () => {
    expect(answerMark(a({})).text).toBe("Solved, says the grader");
    expect(answerMark(a({ solved: false, judgedBy: "Jordan", judgedAt: "2026-11-20T10:00:00Z" })).text).toBe("Not solved, says Jordan");
    expect(answerMark(a({ verdict: "partial", solved: null })).kind).toBe("to_judge");
  });

  it("explains a model that didn't answer in plain words", () => {
    expect(missedLine(a({ state: "skipped", answer: null, error: "cost_cap" }))).toMatch(/cost cap/);
    expect(missedLine(a({ state: "refused", answer: null, error: "not_shared" }))).toMatch(/Sharing/);
    expect(missedLine(a({ state: "failed", answer: null, error: "HTTP 429" }))).toBe("It couldn't be reached.");
    expect(missedLine(a({}))).toBeNull();
  });

  it("names models as people say them", () => {
    expect(modelName("openai/gpt-6.2-astra")).toBe("GPT-6.2 Astra");
    expect(modelName("mistral/large-9")).toBe("large-9");
  });
});

describe("the cost and the errors", () => {
  it("promises the worst case and the cap before anything is sent", () => {
    expect(costLine({ ceilingUsd: 1.534, costCapUsd: 2 })).toBe("This check costs at most $1.53. Binary stops before it would pass $2.00.");
  });

  it("turns each database refusal into a plain line, and anything else into a retry", () => {
    expect(modelCheckFailure({ code: "BL951" })).toMatchObject({ status: 409, message: expect.stringMatching(/Sharing is off/) });
    expect(modelCheckFailure({ code: "BL975" }).status).toBe(403);
    expect(modelCheckFailure({ code: "XX000" }).status).toBe(500);
  });

  it("takes only the three requests the page makes", () => {
    expect(ModelCheckRequest.safeParse({ action: "start", taskId: "7d1c2c39-5a4e-4c55-9d7b-0c3c1a7e0001" }).success).toBe(true);
    expect(ModelCheckRequest.safeParse({ action: "send", model: "x" }).success).toBe(false);
  });
});

describe("the database's JSON", () => {
  it("parses snake_case rows into the page's shape, numbers from numeric strings", () => {
    const parsed = RunModelChecksJson.parse({
      run_id: "7d1c2c39-5a4e-4c55-9d7b-0c3c1a7d0001",
      title: "BM3",
      setup: { models: [{ model: "x-ai/grok-4.7", ceiling_usd: "0.18" }], unreachable: [], grader: "g", cost_cap_usd: "2.00", ceiling_usd: "0.18", missing: [], ready: true },
      confirmed_cause: "pH",
      question: "Why?",
      rubric: [{ criterion: "Names pH", points: 2 }],
      can_judge: true,
      tasks: [],
    });
    expect(parsed.setup).toMatchObject({ costCapUsd: 2, models: [{ model: "x-ai/grok-4.7", ceilingUsd: 0.18 }] });
    expect(fixtureModelChecks("checked").tasks[0]?.check?.answers).toHaveLength(4);
  });
});
