import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Proves the planned-versus-actual tests can fail. Each entry breaks one guard in
// db/migrations/0036_run_evidence.sql, reruns run-evidence.db.test.ts and expects it to go red;
// the migration is put back after every one. Run from apps/web with BL_WEB_TEST_DB set:
//   node scripts/run-evidence-guards.mjs

const migration = fileURLToPath(new URL("../../../db/migrations/0036_run_evidence.sql", import.meta.url));
const original = readFileSync(migration, "utf8");

const GUARDS = [
  ["edited files: only the run's lab", "select case when exists (select 1 from runs where id = p_run_id and is_lab_member(lab_id)) then (", "select case when true then ("],
  [
    "edited files: a file still holding the run's content isn't listed",
    "      and not exists (\n        select 1 from file_locations fl\n        where fl.lab_id = f.lab_id and fl.sha256 = f.sha256 and fl.deleted_at is null\n      )\n  ) end",
    "  ) end",
  ],
  ["edited files: a place gone from the folder isn't one", "and fl.deleted_at is null\n      order by fv.seen_at desc", "\n      order by fv.seen_at desc"],
  ["edited files: the latest is the newest version", "order by fv.number desc limit 1", "order by fv.number limit 1"],
  ["suggestion: saved on or before the run's day", "<= coalesce(r.started_on, current_date) as before", ">= coalesce(r.started_on, current_date) as before"],
  ["choices: only the run's lab", "where r.id = p_run_id and is_lab_member(r.lab_id)\n  ),", "where r.id = p_run_id\n  ),"],
  ["choices: only the lab's protocols", "join protocol_versions pv on pv.lab_id = me.lab_id", "join protocol_versions pv on true"],
  ["choices: no archived protocols", "and p.archived_at is null and p.kind = 'protocol'", "and p.kind = 'protocol'"],
  ["choices: no tutorials", "and p.archived_at is null and p.kind = 'protocol'", "and p.archived_at is null"],
  ["bodies: only the run's lab", "r.as_run_based_on\n  where r.id = p_run_id and is_lab_member(r.lab_id)", "r.as_run_based_on\n  where r.id = p_run_id"],
  ["set_run_plan checks the caller", "  r runs := member_run(p_run_id);\nbegin\n  if p_version_id", "  r runs := (select x from runs x where x.id = p_run_id);\nbegin\n  if p_version_id"],
  ["set_run_plan: a version of this lab", "  if p_version_id is not null and not exists", "  if false and not exists"],
  ["save_as_run checks the caller", "  r runs := member_run(p_run_id);\n  v_body", "  r runs := (select x from runs x where x.id = p_run_id);\n  v_body"],
  ["save_as_run: too long says so", "  if length(v_body) > 200000 then", "  if false then"],
  ["save_as_run: a version of this lab", "  if v_based_on is not null and not exists", "  if false and not exists"],
  ["save_as_run: an empty text clears it", "v_body text := case when coalesce(p_body, '') ~ '^\\s*$' then null else p_body end;", "v_body text := p_body;"],
  [
    "save_as_run: the same text again changes nothing",
    "where id = r.id and (as_run_body, as_run_based_on) is distinct from (v_body, v_based_on);",
    "where id = r.id;",
  ],
  ["the suggestion alone isn't the members'", "grant execute on function\n  run_edited_files(uuid),", "grant execute on function\n  run_suggested_version(uuid), run_edited_files(uuid),"],
  ["signed out callers can't call them", "from public, anon, authenticated;", "from authenticated;"],
];

// "passed", "failed" (a test's assertion went red) or "broken" (the migration no longer
// applies, which proves nothing about the tests).
function runTests() {
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "--project", "db", "src/lib/__tests__/run-evidence.db.test.ts"], { stdio: "pipe" });
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
    process.stdout.write(`${{ failed: "caught   ", passed: "MISSED   ", broken: "BROKE SQL" }[result]} ${name}\n`);
    if (result === "failed") held += 1;
    else slipped.push(name);
  }
} finally {
  writeFileSync(migration, original);
}
process.stdout.write(`\n${held} of ${held + slipped.length} broken guards made the tests fail.\n`);
if (slipped.length > 0) process.exit(1);
