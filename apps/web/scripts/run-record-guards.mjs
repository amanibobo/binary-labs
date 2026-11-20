import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Proves the run record's database tests can fail. Each entry breaks one guard in
// db/migrations/0034_runs.sql, reruns run-record.db.test.ts and expects it to go red; the
// migration is put back after every one. Run from apps/web with BL_WEB_TEST_DB set:
//   node scripts/run-record-guards.mjs

const migration = fileURLToPath(new URL("../../../db/migrations/0034_runs.sql", import.meta.url));
const original = readFileSync(migration, "utf8");

const GUARDS = [
  ["the cause check's null hole", "check (status is not distinct from 'failed' or status is not distinct from 'odd'\n    or", "check (status in ('failed', 'odd')\n    or"],
  ["a confirmed cause needs a confirmer", "check ((confirmed_cause is null) = (confirmed_by is null)\n    and (confirmed_by is null) = (confirm_method is null)\n    and (confirm_method is null) = (confirmed_at is null)),", ""],
  ["the confirmer is kept (set null instead)", "foreign key (confirmed_by, lab_id) references people (id, lab_id) on delete restrict,", "foreign key (confirmed_by, lab_id) references people (id, lab_id) on delete set null (confirmed_by),"],
  ["member_run checks the lab", "  if not is_lab_member(r.lab_id) then\n    raise exception 'not a member of this lab' using errcode = '42501';\n  end if;\n  return r;", "  return r;"],
  ["create_run checks the lab", "  if auth.uid() is null or not is_lab_member(p_lab_id) then\n    raise exception 'not a member of this lab' using errcode = '42501';\n  end if;\n  if coalesce(cardinality(p_shas), 0) not between 1 and 50 then\n    raise exception 'pick 1 to 50 files' using errcode = 'BL908';\n  end if;\n  select * into l", "  select * into l"],
  ["run_json checks the lab", "where r.id = p_run_id and is_lab_member(r.lab_id)", "where r.id = p_run_id"],
  ["run_file checks the lab", "where f.run_id = p_run_id and f.sha256 = p_sha256 and is_lab_member(f.lab_id)", "where f.run_id = p_run_id and f.sha256 = p_sha256"],
  ["runs are read by their lab only", "create policy runs_select on runs for select using (is_lab_member(lab_id));", "create policy runs_select on runs for select using (true);"],
  ["the log is read by its lab only", "create policy run_log_select on run_log for select using (is_lab_member(lab_id));", "create policy run_log_select on run_log for select using (true);"],
  ["exports are read by their lab only", "create policy task_exports_select on task_exports for select using (is_lab_member(lab_id));", "create policy task_exports_select on task_exports for select using (true);"],
  ["dismissing checks the lab", "  if auth.uid() is null or not is_lab_member(p_lab_id) then\n    raise exception 'not a member of this lab' using errcode = '42501';\n  end if;\n  insert into run_suggestion_dismissals", "  insert into run_suggestion_dismissals"],
  ["a run's file is the lab's own content", "create trigger run_files_check before insert on run_files\nfor each row execute function run_files_check();", ""],
  ["a picked file has a place in the lab", "      raise exception 'that file isn''t in this lab' using errcode = 'BL901';\n    end if;\n    if is_recording", "      null;\n    end if;\n    if is_recording"],
  ["a recording isn't evidence", "    if is_recording(p_lab_id, v_sha) then", "    if false then"],
  ["a run keeps one file", "  if not exists (select 1 from run_files where run_id = r.id and sha256 <> p_sha256) then", "  if false then"],
  ["a status change asks before clearing causes", "and not coalesce(p_clear_causes, false) then", "and false then"],
  ["a retry can't loop", "  if p_retry_of = r.id or exists (", "  if false and exists ("],
  ["a retry is a run of this lab", "  if not exists (select 1 from runs where id = p_retry_of and lab_id = r.lab_id) then", "  if false then"],
  ["only evidence names a file's run", "where f.lab_id = p_lab_id and f.sha256 = any (p_shas) and f.role = 'evidence'", "where f.lab_id = p_lab_id and f.sha256 = any (p_shas)"],
  ["only vouched labels are suggested", "where l.outcome is not null and l.status in ('accepted', 'corrected')", "where l.outcome is not null"],
  ["suggestions stay put away", "  where open.yes\n", "\n"],
  ["export: the run's switch", "    case when not r.share then 'run_off' end,\n", ""],
  ["export: the lab's agreement", "    case when l.sharing_agreed_at is null then 'lab_off' end,\n", ""],
  ["export: never a demo lab", "    case when l.plan = 'demo' then 'demo_lab' end\n", "    null\n"],
  ["export: the trigger rechecks consent", "  v_blocks := run_export_blocks(new.run_id);\n  if v_blocks is null or cardinality(v_blocks) > 0 then", "  v_blocks := run_export_blocks(new.run_id);\n  if false then"],
  ["export: a grant must be allowed", "if not found or g.action <> 'export.allowed' or", "if not found or"],
  ["export: a grant is for its own run", "or g.run_id is distinct from new.run_id\n", "\n"],
  ["export: a grant expires", "or g.at < now() - interval '1 hour' then", "then"],
  ["export: a grant is used once", "grant_id bigint not null unique references run_log (id)", "grant_id bigint not null references run_log (id)"],
  ["export: a withdrawn folder stays withdrawn", "      or (old.withdrawn_at is not null and new.withdrawn_at is null) then", "      then"],
  ["export: model calls recheck consent", "create trigger task_model_runs_check before insert on task_model_runs\nfor each row execute function task_model_runs_check();", ""],
  ["a change to a shared run turns sharing off", "    new.share := false;", "    null;"],
  ["a file change turns sharing off", "  update runs set share = false where id = v_row.run_id and share;", ""],
  ["sharing off withdraws the folders", "      update task_exports set withdrawn_at = now() where run_id = new.id and withdrawn_at is null;", "      null;"],
  ["the agreement going off withdraws the folders", "    update task_exports set withdrawn_at = now() where lab_id = new.id and withdrawn_at is null;", "    null;"],
  ["only the listed functions are the members'", "  member_run(uuid), is_recording(uuid, text), run_ref_json(uuid), run_json(uuid),\n  put_run_files", "  is_recording(uuid, text), run_ref_json(uuid), run_json(uuid),\n  put_run_files"],
  ["the worker's export check isn't the members'", "  run_export_blocks(uuid), task_exports_check(), assert_exportable(uuid), task_model_runs_check(),\n  member_run", "  run_export_blocks(uuid), task_exports_check(), task_model_runs_check(),\n  member_run"],
  ["lab deletion: a run's files go without a log row", "  if not exists (select 1 from runs where id = v_row.run_id) then\n    return null;\n  end if;\n", ""],
];

// "passed", "failed" (a test's assertion went red) or "broken" (the migration no longer
// applies, which proves nothing about the tests).
function runTests() {
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "--project", "db", "src/lib/__tests__/run-record.db.test.ts"], { stdio: "pipe" });
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
    writeFileSync(migration, original.replace(from, to));
    const result = runTests();
    console.log(`${{ failed: "caught   ", passed: "MISSED   ", broken: "BROKE SQL" }[result]} ${name}`);
    if (result === "failed") held += 1;
    else slipped.push(name);
  }
} finally {
  writeFileSync(migration, original);
}
console.log(`\n${held} of ${held + slipped.length} broken guards made the tests fail.`);
if (slipped.length > 0) process.exit(1);
