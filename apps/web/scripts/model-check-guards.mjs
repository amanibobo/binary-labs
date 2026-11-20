import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Proves the model check's database tests can fail. Each entry breaks one guard in
// db/migrations/0040_model_check.sql, reruns model-check.db.test.ts and expects it to go red;
// the migration is put back after every one. Run from apps/web with BL_WEB_TEST_DB set:
//   node scripts/model-check-guards.mjs

const migration = fileURLToPath(new URL("../../../db/migrations/0040_model_check.sql", import.meta.url));
const original = readFileSync(migration, "utf8");

const GUARDS = [
  ["a task is the caller's lab's", "  if not found or not is_lab_member(t.lab_id) then\n    raise exception 'no such task'", "  if not found then\n    raise exception 'no such task'"],
  ["two presses make one check (the run is locked)", "  perform member_run(t.run_id);\n  return t;", "  return t;"],
  ["no models, no check", "if not found or jsonb_array_length(s.models) = 0 or s.grader is null then", "if not found or s.grader is null then"],
  ["no grader, no check", "if not found or jsonb_array_length(s.models) = 0 or s.grader is null then", "if not found or jsonb_array_length(s.models) = 0 then"],
  ["one check of a task at a time", "  if exists (select 1 from task_model_runs where task_id = t.id and state = 'waiting') then", "  if false then"],
  ["only an answer is judged", "  if a.state <> 'answered' then", "  if false then"],
  ["the person who ran it doesn't judge", "  if exists (select 1 from people p where p.id = r.person_id and p.member_user_id = auth.uid()) then\n    raise exception 'the person who ran it", "  if false then\n    raise exception 'the person who ran it"],
  ["an answer is answered only with its text", "  add constraint task_model_runs_answer_state check ((state = 'answered') = (answer is not null)),\n", ""],
  ["a verdict needs an answer", "  add constraint task_model_runs_verdict_state check (verdict is null or state = 'answered'),\n", ""],
  ["solved follows the grader until someone judges", "    judged_at is not null\n    or solved is not distinct from", "    true\n    or solved is not distinct from"],
  ["a withdrawn folder isn't kept", "  if p_keep and t.withdrawn_at is not null then", "  if false then"],
  ["the page reads its own lab only", "  where r.id = p_run_id and is_lab_member(r.lab_id)\n$$;", "  where r.id = p_run_id\n$$;"],
  ["the page shows the newest check", "group by x.check_id order by min(x.started_at) desc limit 1", "group by x.check_id order by min(x.started_at) limit 1"],
  ["the person who ran it is told they can't judge", "    'can_judge', not exists (", "    'can_judge', true or not exists ("],
  ["the setup is the worker's to write", "revoke all on model_check_setup from anon, authenticated;\n", "grant all on model_check_setup to authenticated;\n"],
  ["the lab lookups aren't the members'", "grant execute on function\n  model_check_setup_json(), request_model_check(uuid)", "grant execute on function\n  member_task(uuid), model_check_setup_json(), request_model_check(uuid)"],
];

// "passed", "failed" (a test's assertion went red) or "broken" (the migration no longer
// applies, which proves nothing about the tests).
function runTests() {
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "--project", "db", "src/lib/__tests__/model-check.db.test.ts"], { stdio: "pipe" });
    return "passed";
  } catch (err) {
    return /Tests\s+\d+ failed/.test(String(err.stdout)) ? "failed" : "broken";
  }
}

const only = process.argv[2];
let held = 0;
const slipped = [];
try {
  for (const [name, from, to] of GUARDS) {
    if (only !== undefined && !name.includes(only)) continue;
    if (original.split(from).length !== 2) throw new Error(`"${name}": its text is in the migration ${original.split(from).length - 1} times, expected once`);
    // A function, so a "$$" in the replacement stays as written.
    writeFileSync(migration, original.replace(from, () => to));
    const result = runTests();
    process.stdout.write(`${{ failed: "caught   ", passed: "MISSED   ", broken: "BROKE SQL" }[result]} ${name}\n`);
    if (result === "failed") held += 1;
    else slipped.push(name);
  }
} finally {
  writeFileSync(migration, original);
}
process.stdout.write(`\n${held} of ${held + slipped.length} broken guards made the tests fail.\n`);
if (slipped.length > 0) process.exit(1);
