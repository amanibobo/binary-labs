import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CreateLabResult } from "../domain";
import { LabId, Sha256 } from "../ids";
import { RunModelChecksJson, tally } from "../model-check";

// The model check's functions against the real migrations: as the person who ran the run, as
// another member of the lab (the second scientist), as a member of another lab, signed out, and
// as the worker (the owner, which skips row security and writes the answers).

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const ada = "00000000-0000-4000-8000-0000000c0001";
const ben = "00000000-0000-4000-8000-0000000c0002";
const cy = "00000000-0000-4000-8000-0000000c0003";
const sha = (n: number) => Sha256.parse(`c${n.toString(16).padStart(63, "0")}`);

async function asRole<T>(role: "authenticated" | "anon", userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claims', $1, true)", [userId === null ? "" : JSON.stringify({ sub: userId })]);
    const out = await fn();
    await db.query("commit");
    return out;
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
}
const asUser = <T>(userId: string, fn: () => Promise<T>) => asRole("authenticated", userId, fn);
const one = z.object({ v: z.unknown() });
const call = (userId: string, sql: string, params: unknown[]) =>
  asUser(userId, async () => one.parse((await db.query(`select ${sql} as v`, params)).rows[0]).v);
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);
const owner = (sql: string, params: unknown[] = []) => db.query(sql, params);
const value = async (sql: string, params: unknown[] = []) => (await owner(sql, params)).rows[0]?.v;
const count = async (sql: string, params: unknown[] = []) => Number(await value(`select count(*) as v from ${sql}`, params));

let lab: LabId;
let otherLab: LabId;
let runId: string;
let task: string;

const MODELS = [
  { model: "anthropic/claude-opus-5.5", ceiling_usd: 0.32 },
  { model: "openai/gpt-6.2-astra", ceiling_usd: 0.64 },
  { model: "google/gemini-4-neon", ceiling_usd: 0.24 },
  { model: "x-ai/grok-4.7", ceiling_usd: 0.13 },
];
const publish = (models: unknown[] = MODELS, grader: string | null = "anthropic/claude-sonnet-5.5") =>
  owner(
    `insert into model_check_setup (models, grader, cost_cap_usd, missing) values ($1, $2, 2.00, '{}')
     on conflict (id) do update set models = excluded.models, grader = excluded.grader`,
    [JSON.stringify(models), grader],
  );
const share = (on: boolean) => owner("update runs set share = $2 where id = $1", [runId, on]);
async function buildTask(): Promise<string> {
  await share(true);
  const g = await value("insert into run_log (lab_id, run_id, via, action) values ($1, $2, 'person', 'export.allowed') returning id as v", [lab, runId]);
  return z.string().parse(await value("insert into task_exports (lab_id, run_id, grant_id, purpose) values ($1, $2, $3, 'task') returning id as v", [lab, runId, g]));
}
const start = (userId: string, taskId: string) => call(userId, "request_model_check($1)", [taskId]);
const judge = (userId: string, answerId: string, solved: boolean | null, note = "") => call(userId, "judge_model_answer($1, $2, $3)", [answerId, solved, note]);
const keep = (userId: string, taskId: string, on: boolean) => call(userId, "keep_model_task($1, $2)", [taskId, on]);
const read = async (userId: string) => {
  const json = await call(userId, "run_model_checks_json($1)", [runId]);
  return json === null ? null : RunModelChecksJson.parse(json);
};
const answersOf = async (checkId: unknown) =>
  z.array(z.object({ id: z.string(), model: z.string() })).parse((await owner("select id, model from task_model_runs where check_id = $1 order by model", [checkId])).rows);
// What the worker writes once a model has answered and the grader has spoken.
const answer = (id: string, verdict: string, text = "The buffer pH was off.") =>
  owner(
    `update task_model_runs set state = 'answered', answer = $2, verdict = $3, reason = 'because',
       solved = case $3 when 'solved' then true when 'not_solved' then false end, graded_at = now(), cost_usd = 0.05 where id = $1`,
    [id, text, verdict],
  );

beforeAll(async () => {
  await db.connect();
  await owner("insert into auth.users (id, email) values ($1, 'ada@check.test'), ($2, 'ben@check.test'), ($3, 'cy@check.test')", [ada, ben, cy]);
  lab = LabId.parse(CreateLabResult.parse(await call(ada, "create_lab('Check lab')", [])));
  otherLab = LabId.parse(CreateLabResult.parse(await call(cy, "create_lab('Other check lab')", [])));
  await owner("insert into members (lab_id, user_id, role) values ($1, $2, 'member')", [lab, ben]);
  const adaPerson = await value("insert into people (lab_id, display_name, member_user_id) values ($1, 'Ada', $2) returning id as v", [lab, ada]);
  await owner("insert into people (lab_id, display_name, member_user_id) values ($1, 'Ben', $2)", [lab, ben]);
  const source = await value("insert into sources (lab_id, kind, root_path) values ($1, 'local', '/c') returning id as v", [lab]);
  await owner("insert into blobs (sha256, size, mime, file_kind) values ($1, 10, 'text/csv', 'spreadsheet')", [sha(1)]);
  await owner(
    `insert into file_locations (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev, sha256, index_state)
     values ($1, $2, 'p', '/p', 'plate.csv', 10, now(), 'r', $3, 'indexed')`,
    [lab, source, sha(1)],
  );
  const run = z.object({ id: z.string() }).parse(await call(ada, "create_run($1, $2, '{}'::jsonb)", [lab, [sha(1)]]));
  runId = run.id;
  await owner(
    `update runs set status = 'failed', status_at = now(), person_id = $2, confirmed_cause = 'The lysis buffer was pH 9.', confirmed_by = $2,
       confirm_method = 'control', confirmed_at = now() where id = $1`,
    [runId, adaPerson],
  );
  await owner("insert into run_rubrics (run_id, lab_id, question, rubric) values ($1, $2, 'Why did the prep fail?', $3)", [
    runId,
    lab,
    JSON.stringify([{ criterion: "Names the buffer pH", points: 2 }]),
  ]);
  await owner("update labs set sharing_agreed_at = now(), sharing_agreement = 'v1' where id = $1", [lab]);
});

beforeEach(async () => {
  await owner("delete from model_check_setup");
  await owner("delete from task_exports where lab_id = $1", [lab]);
  await owner("update labs set sharing_agreed_at = now(), sharing_agreement = 'v1' where id = $1", [lab]);
  await publish();
  task = await buildTask();
});

afterAll(async () => {
  await db.end();
});

describe("request_model_check", () => {
  it("makes one waiting answer per model the worker can reach, each carrying the cost cap shown", async () => {
    const check = await start(ben, task);
    const rows = z
      .array(z.object({ model: z.string(), state: z.string(), cost_cap_usd: z.string(), requested_by: z.string() }))
      .parse((await owner("select model, state, cost_cap_usd, requested_by from task_model_runs where check_id = $1 order by model", [check])).rows);
    expect(rows).toEqual(MODELS.map((m) => ({ model: m.model, state: "waiting", cost_cap_usd: "2.00", requested_by: ben })).sort((a, b) => a.model.localeCompare(b.model)));
  });

  it("is refused before anything is asked when the run's switch went off after the folder was built", async () => {
    await share(false);
    expect(await codeOf(start(ben, task))).toBe("BL951");
    expect(await count("task_model_runs where task_id = $1", [task])).toBe(0);
  });

  it("is refused when the lab's agreement is off or the lab is a demo lab", async () => {
    await owner("update labs set sharing_agreed_at = null, sharing_agreement = null where id = $1", [lab]);
    expect(await codeOf(start(ben, task))).toBe("BL951");
    await owner("update labs set sharing_agreed_at = now(), sharing_agreement = 'v1' where id = $1", [lab]);
    const fresh = await buildTask();
    await owner("update labs set plan = 'demo' where id = $1", [lab]);
    expect(await codeOf(start(ben, fresh))).toBe("BL951");
    await owner("update labs set plan = 'pilot' where id = $1", [lab]);
    expect(await count("task_model_runs where lab_id = $1", [lab])).toBe(0);
  });

  it("says the check isn't set up when the worker has no keys, no models or no grader", async () => {
    await owner("delete from model_check_setup");
    expect(await codeOf(start(ben, task))).toBe("BL972");
    await publish([]);
    expect(await codeOf(start(ben, task))).toBe("BL972");
    await publish(MODELS, null);
    expect(await codeOf(start(ben, task))).toBe("BL972");
  });

  it("waits for a check to finish before starting another", async () => {
    const first = await start(ben, task);
    expect(await codeOf(start(ben, task))).toBe("BL973");
    await owner("update task_model_runs set state = 'failed', error = 'x' where check_id = $1", [first]);
    expect(await codeOf(start(ben, task))).toBe("ok");
  });

  it("makes one check when two people press at once: the second waits for the first, then hears it is running", async () => {
    const other = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
    await other.connect();
    try {
      await db.query("begin");
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ben })]);
      await db.query("select request_model_check($1)", [task]);
      await other.query("begin");
      await other.query("set local role authenticated");
      await other.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ada })]);
      const second = codeOf(other.query("select request_model_check($1)", [task]));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await db.query("commit");
      expect(await second).toBe("BL973");
      await other.query("rollback");
    } finally {
      await other.end();
    }
    expect(await count("task_model_runs where task_id = $1", [task])).toBe(MODELS.length);
  });

  it("is a member's alone: another lab and a signed-out caller get nothing, and nobody writes the rows directly", async () => {
    expect(await codeOf(start(cy, task))).toBe("BL971");
    expect(await codeOf(asRole("anon", null, () => db.query("select request_model_check($1)", [task])))).toBe("42501");
    expect(await codeOf(asUser(ben, () => db.query("insert into task_model_runs (task_id, lab_id, model) values ($1, $2, 'mine')", [task, lab])))).toBe("42501");
    expect(await codeOf(asUser(ben, () => db.query("update model_check_setup set cost_cap_usd = 100")))).toBe("42501");
    expect(await count("task_model_runs where task_id = $1", [task])).toBe(0);
  });
});

describe("what decides solved", () => {
  it("is the grader's verdict alone until someone judges: solved or not, empty for partial and unclear", async () => {
    const [a] = await answersOf(await start(ben, task));
    expect(await codeOf(owner("update task_model_runs set state = 'answered', answer = 'x', verdict = 'partial', solved = true where id = $1", [a?.id]))).toBe("23514");
    expect(await codeOf(owner("update task_model_runs set state = 'answered', answer = 'x', verdict = 'not_solved', solved = true where id = $1", [a?.id]))).toBe("23514");
    expect(await codeOf(owner("update task_model_runs set state = 'answered' where id = $1", [a?.id]))).toBe("23514");
    expect(await codeOf(owner("update task_model_runs set verdict = 'solved', solved = true where id = $1", [a?.id]))).toBe("23514");
  });

  it("lets the second scientist judge a partial answer, and their judgment wins", async () => {
    const [a, b] = await answersOf(await start(ben, task));
    await answer(z.string().parse(a?.id), "partial");
    await answer(z.string().parse(b?.id), "solved");
    await judge(ben, z.string().parse(a?.id), true, "It names the pH.");
    await judge(ben, z.string().parse(b?.id), false, "Wrong buffer.");
    const rows = z.array(z.object({ solved: z.boolean(), judged_by: z.string(), judged_note: z.string() })).parse(
      (await owner("select solved, judged_by, judged_note from task_model_runs where id = any($1) order by model", [[a?.id, b?.id]])).rows,
    );
    expect(rows).toEqual([
      { solved: true, judged_by: ben, judged_note: "It names the pH." },
      { solved: false, judged_by: ben, judged_note: "Wrong buffer." },
    ]);
    await judge(ben, z.string().parse(a?.id), null);
    expect(await value("select solved as v from task_model_runs where id = $1", [a?.id])).toBeNull();
  });

  it("won't let the person who ran the run judge, nor anyone judge an answer that never came", async () => {
    const [a, b] = await answersOf(await start(ben, task));
    await answer(z.string().parse(a?.id), "unclear");
    expect(await codeOf(judge(ada, z.string().parse(a?.id), true))).toBe("BL975");
    expect(await codeOf(judge(ben, z.string().parse(b?.id), true))).toBe("BL974");
    expect(await codeOf(judge(cy, z.string().parse(a?.id), true))).toBe("BL971");
    expect(await value("select solved as v from task_model_runs where id = $1", [a?.id])).toBeNull();
  });
});

describe("keeping a task", () => {
  it("keeps it with who and when, lets it go, and won't keep a withdrawn folder", async () => {
    await keep(ben, task, true);
    expect((await owner("select kept_by from task_exports where id = $1 and kept_at is not null", [task])).rows).toEqual([{ kept_by: ben }]);
    await keep(ben, task, false);
    expect((await owner("select kept_by, kept_at from task_exports where id = $1", [task])).rows).toEqual([{ kept_by: null, kept_at: null }]);
    await share(false);
    expect(await codeOf(keep(ben, task, true))).toBe("BL976");
    expect(await codeOf(keep(cy, task, true))).toBe("BL971");
  });
});

describe("run_model_checks_json", () => {
  it("shows the newest check of each folder with every answer, the rubric and what it costs", async () => {
    const old = await start(ben, task);
    await owner("update task_model_runs set state = 'failed', error = 'x', started_at = now() - interval '1 day' where check_id = $1", [old]);
    const [a, b, c, d] = await answersOf(await start(ben, task));
    await answer(z.string().parse(a?.id), "solved");
    await answer(z.string().parse(b?.id), "not_solved");
    await answer(z.string().parse(c?.id), "unclear");
    await owner("update task_model_runs set state = 'skipped', error = 'cost_cap' where id = $1", [d?.id]);
    await judge(ben, z.string().parse(c?.id), false);

    const seen = await read(ben);
    expect(seen?.setup).toMatchObject({ ready: true, costCapUsd: 2, ceilingUsd: 1.33, grader: "anthropic/claude-sonnet-5.5" });
    expect(seen?.rubric).toEqual([{ criterion: "Names the buffer pH", points: 2 }]);
    expect(seen?.confirmedCause).toBe("The lysis buffer was pH 9.");
    expect(seen?.canJudge).toBe(true);
    expect(seen?.tasks).toHaveLength(1);
    const check = seen?.tasks[0]?.check;
    expect(check?.answers.map((x) => x.state)).toEqual(["answered", "answered", "answered", "skipped"]);
    expect(check?.spentUsd).toBeCloseTo(0.15);
    expect(check?.answers[2]).toMatchObject({ judgedBy: "Ben", solved: false });
    expect(tally(check?.answers ?? [])).toMatchObject({ answered: 3, solved: 1, notSolved: 2, toJudge: 0, missed: 1 });
    expect((await read(ada))?.canJudge).toBe(false);
  });

  it("reads as nothing for another lab", async () => {
    expect(await read(cy)).toBeNull();
    expect(otherLab).toBeTruthy();
  });
});

describe("grants", () => {
  it("gives members the page's functions and keeps the lab lookups to the owner", async () => {
    const granted = z.array(z.object({ name: z.string(), member: z.boolean(), anon: z.boolean() })).parse(
      (
        await owner(
          `select p.proname as name, has_function_privilege('authenticated', p.oid, 'execute') as member,
             has_function_privilege('anon', p.oid, 'execute') as anon
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any($1) order by 1`,
          [["model_check_setup_json", "member_task", "request_model_check", "judge_model_answer", "keep_model_task", "member_name", "run_model_checks_json"]],
        )
      ).rows,
    );
    expect(granted.filter((f) => f.anon)).toEqual([]);
    expect(granted.filter((f) => f.member).map((f) => f.name)).toEqual(["judge_model_answer", "keep_model_task", "model_check_setup_json", "request_model_check", "run_model_checks_json"]);
  });
});
