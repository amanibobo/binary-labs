import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Proves the failure record's database tests can fail. Each entry breaks one guard in
// db/migrations/0035_run_failure.sql, reruns run-failure.db.test.ts and expects it to go red;
// the migration is put back after every one. Run from apps/web with BL_WEB_TEST_DB set:
//   node scripts/run-failure-guards.mjs [part of a guard's name]

const migration = fileURLToPath(new URL("../../../db/migrations/0035_run_failure.sql", import.meta.url));
const original = readFileSync(migration, "utf8");

const SUSPECT = "create function set_suspected_cause(p_run_id uuid, p_cause text) returns jsonb\nlanguage plpgsql security definer set search_path = public as $$\ndeclare\n  r runs := member_run(p_run_id);";
const CONFIRM = ") returns jsonb\nlanguage plpgsql security definer set search_path = public as $$\ndeclare\n  r runs := member_run(p_run_id);\n  v_cause text := failure_text(p_cause, 4000);\n  v_note";
const ATTEST = "create function attest_cause(p_run_id uuid) returns jsonb\nlanguage plpgsql security definer set search_path = public as $$\ndeclare\n  r runs := member_run(p_run_id);";
const TYPE = "returns jsonb\nlanguage plpgsql security definer set search_path = public as $$\ndeclare\n  r runs := member_run(p_run_id);\n  v_empty";
const unchecked = (text) => text.replace("member_run(p_run_id)", "(select x from runs x where x.id = p_run_id)");

const GUARDS = [
  ["set_suspected_cause checks the lab", SUSPECT, unchecked(SUSPECT)],
  ["confirm_cause checks the lab", CONFIRM, unchecked(CONFIRM)],
  ["attest_cause checks the lab", ATTEST, unchecked(ATTEST)],
  ["set_failure_type checks the lab", TYPE, unchecked(TYPE)],
  ["a long text is refused", "  if length(v) > p_max then", "  if false then"],
  ["a blank suspected cause is refused", "  if p_cause is not null and v_cause is null then\n    raise exception 'write the cause in a few words' using errcode = 'BL917';\n  end if;\n  if v_cause is not null and r.status", "  if v_cause is not null and r.status"],
  ["a suspected cause needs failed or odd", "  if v_cause is not null and r.status is distinct from 'failed' and r.status is distinct from 'odd' then", "  if v_cause is not null and r.status not in ('failed', 'odd') then"],
  ["a blank confirmed cause is refused", "  if v_cause is null then\n    raise exception 'write the cause in a few words' using errcode = 'BL917';\n  end if;\n  if r.status", "  if r.status"],
  ["a confirmed cause needs failed or odd", "  if r.status is distinct from 'failed' and r.status is distinct from 'odd' then\n    raise exception 'this run didn''t fail and isn''t odd' using errcode = 'BL913';\n  end if;\n  select p.member_user_id", "  if r.status not in ('failed', 'odd') then\n    raise exception 'this run didn''t fail and isn''t odd' using errcode = 'BL913';\n  end if;\n  select p.member_user_id"],
  ["the confirmer is one of the lab's People", "from people p where p.id = p_person_id and p.lab_id = r.lab_id;", "from people p where p.id = p_person_id;"],
  ["a method is needed", "  if p_method is null\n    or (p_method = 'control'", "  if false\n    or (p_method = 'control'"],
  ["a control is one of this run's files", "      or not exists (select 1 from run_files f where f.run_id = r.id and f.sha256 = p_confirm_sha256)))", "))"],
  ["a control names no run", "(p_method = 'control' and (p_confirm_run is not null or p_confirm_sha256 is null", "(p_method = 'control' and (p_confirm_sha256 is null"],
  ["a repeat is never the run itself", " or p_confirm_run = r.id\n", "\n"],
  ["a repeat is a run of this lab", " and o.lab_id = r.lab_id))))", "))))"],
  ["a repeat names no file", "(p_method = 'repeat' and (p_confirm_sha256 is not null or p_confirm_run = r.id", "(p_method = 'repeat' and (p_confirm_run = r.id"],
  ["the PI's opinion takes no evidence", "    or (p_method = 'pi_opinion' and (p_confirm_run is not null or p_confirm_sha256 is not null)) then", "    then"],
  ["a confirmation can't be in the future", "  if v_at > now() + interval '5 minutes' then", "  if false then"],
  ["only the confirmer's own entry is a yes", "    confirmer_attested_at = case when v_yours then now() end\n", "    confirmer_attested_at = now()\n"],
  ["a change by someone else needs the yes again", "    confirmer_attested_at = case when v_yours then now() end\n", "    confirmer_attested_at = case when v_yours then now() else confirmer_attested_at end\n"],
  ["withdrawing clears the yes", "confirm_recorded_by = null,\n      confirmer_attested_at = null\n    where id = r.id and confirmed_cause is not null;", "confirm_recorded_by = null\n    where id = r.id and confirmed_cause is not null;"],
  ["only the named confirmer says yes", "p.lab_id = r.lab_id and p.member_user_id = auth.uid()", "p.lab_id = r.lab_id"],
  ["a failure type needs failed or odd", "    if r.status is distinct from 'failed' and r.status is distinct from 'odd' then\n      raise exception 'this run didn''t fail and isn''t odd' using errcode = 'BL913';\n    end if;\n    if (p_technique", "    if (p_technique"],
  ["a technique is a technique", "t.code = p_technique and t.code like 'tech.%'", "t.code = p_technique"],
  ["a step is a step", "t.code = p_step and t.code like 'step.%'", "t.code = p_step"],
  ["a cause category is a cause", "t.code = p_cause and t.code like 'cause.%'", "t.code = p_cause"],
  ["the text helper isn't the members'", "revoke all on function\n  failure_text(text, int), set_suspected_cause", "revoke all on function\n  set_suspected_cause"],
  ["the failure functions are the members'", "  set_failure_type(uuid, smallint, text, text, text), confirmer_choices(uuid), failure_list()\nto authenticated;", "  set_failure_type(uuid, smallint, text, text, text), failure_list()\nto authenticated;"],
];

// "passed", "failed" (a test's assertion went red) or "broken" (the migration no longer
// applies, which proves nothing about the tests).
function runTests() {
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "--project", "db", "src/lib/__tests__/run-failure.db.test.ts"], { stdio: "pipe" });
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
    writeFileSync(migration, original.replace(from, () => to));
    const result = runTests();
    process.stdout.write(`${{ failed: "caught   ", passed: "MISSED   ", broken: "BROKE SQL" }[result]} ${name}\n`);
    if (result === "failed") held += 1;
    else slipped.push(name);
  }
} finally {
  writeFileSync(migration, original);
}
process.stdout.write(`\n${held} of ${held + slipped.length} guards caught\n`);
if (slipped.length > 0) process.exit(1);
