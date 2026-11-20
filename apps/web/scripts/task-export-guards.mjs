import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Proves the task folder's tests can fail. Each entry breaks one guard (in the migration, the
// builder, the store or the scrubber), reruns the test file that should notice and expects it
// to go red; the file is put back after every one. Run from apps/web with BL_WEB_TEST_DB set:
//   node scripts/task-export-guards.mjs [part of a name]

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const SQL = at("../../../db/migrations/0039_task_export.sql");
const STORE = at("../src/lib/task-folder-store.ts");
const FOLDER = at("../src/lib/task-folder.ts");
const SCRUB = at("../src/lib/deidentify.ts");
const DB_TEST = ["db", "src/lib/__tests__/task-export.db.test.ts"];
const UNIT_TEST = ["unit", "src/lib/__tests__/deidentify.test.ts"];

const GUARDS = [
  [SQL, DB_TEST, "a task needs an attested cause", "  if r.confirmed_cause is null or r.confirmer_attested_at is null then", "  if false then"],
  [SQL, DB_TEST, "the reviewer didn't run it", " or p_reviewer_id is not distinct from r.person_id\n", "\n"],
  [SQL, DB_TEST, "the reviewer is one of the lab's people", "    or not exists (select 1 from people where id = p_reviewer_id and lab_id = r.lab_id) then", "    then"],
  [SQL, DB_TEST, "a rubric's points are 1 to 10", "        or not coalesce('[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]'::jsonb @> (e -> 'points'), false)\n", ""],
  [SQL, DB_TEST, "a rubric has only its two keys", "        or (select count(*) from jsonb_object_keys(e)) <> 2\n", ""],
  [SQL, DB_TEST, "gap: no confirmed cause", "    case when r.confirmed_cause is null then 'no_confirmed_cause' end,\n", ""],
  [SQL, DB_TEST, "gap: no task", "      then 'no_task' end,", "      then null end,"],
  [SQL, DB_TEST, "gap: no review", "    ) then 'no_review' end,", "    ) then null end,"],
  [SQL, DB_TEST, "gap: no protocol", "then 'no_protocol' end,", "then null end,"],
  [SQL, DB_TEST, "gap: a file not kept", "    ) then 'file_not_kept' end,", "    ) then null end,"],
  [SQL, DB_TEST, "gap: an excluded experiment", "    ) then 'excluded_experiment' end\n", "    ) then null end\n"],
  [SQL, DB_TEST, "the build checks the gaps", "  v_reasons := run_export_blocks(r.id) || task_export_gaps(r.id);", "  v_reasons := run_export_blocks(r.id);"],
  [SQL, DB_TEST, "a refusal is logged as blocked", "run_via(), 'export.blocked',", "run_via(), 'run.edit',"],
  [SQL, DB_TEST, "a refusal is in the audit log", "  insert into audit_log (lab_id, actor, action, target) values (r.lab_id, auth.uid(), 'run.export_blocked', r.id::text);\n", ""],
  [SQL, DB_TEST, "a refused grant is an answer, not an error", "      when sqlstate 'BL952' or unique_violation or not_null_violation then v_reasons := array['no_grant'];\n", ""],
  [SQL, DB_TEST, "the task is read by its lab only", "  where r.id = p_run_id and is_lab_member(r.lab_id)\n$$;\n\n-- The second scientist", "  where r.id = p_run_id\n$$;\n\n-- The second scientist"],
  [SQL, DB_TEST, "a folder is found by its lab only", " and is_lab_member(t.lab_id)", ""],
  [SQL, DB_TEST, "only a withdrawn folder's files are forgotten", "  if t.withdrawn_at is null then", "  if false then"],
  [SQL, DB_TEST, "exclusions are an admin's", "  if auth.uid() is null or not is_lab_admin(p_lab_id) then", "  if false then"],
  [SQL, DB_TEST, "exclusions are of the kinds a lab can mark", "p_kind not in ('field', 'text', 'folder', 'experiment')", "false"],
  [SQL, DB_TEST, "an excluded experiment is the lab's own", "    or (p_kind = 'experiment' and not exists (\n      select 1 from experiments e where e.lab_id = p_lab_id and e.id::text = btrim(p_value)\n    )) then", "    then"],
  [SQL, DB_TEST, "the readiness check isn't the members'", "grant execute on function\n  run_task_json(uuid),", "grant execute on function\n  task_export_gaps(uuid), run_task_json(uuid),"],
  [STORE, DB_TEST, "the build asks the gate first", '  if (gate.kind === "blocked") return { kind: "ok", value: gate.blocks.includes("no_such_run") ? { kind: "no_run" } : { kind: "blocked", reasons: reasonsOf(gate.blocks) } };\n', ""],
  [STORE, DB_TEST, "download asks the gate", '  if (gate.kind === "blocked") return gate.blocks.includes("no_such_run") ? { kind: "missing" } : { kind: "blocked", reasons: reasonsOf(gate.blocks) };\n', ""],
  [STORE, DB_TEST, "download refuses a withdrawn folder", '  if (row.withdrawn_at !== null || row.storage_prefix === null) return { kind: "withdrawn" };\n', ""],
  [STORE, DB_TEST, "download checks the stored zip", '  if (hash.digest("hex") !== zip.sha256) return { kind: "mismatch" };\n', ""],
  [STORE, DB_TEST, "a copied file is the file the run names", "    if (changed !== undefined) throw", "    if (false) throw"],
  [STORE, DB_TEST, "a refused build leaves nothing in the store", "    await removeFolder(store, prefix);\n    return recorded.kind", "    return recorded.kind"],
  [STORE, DB_TEST, "a leak stops the build", '  if (folder.leaks.length > 0) return { kind: "ok", value: { kind: "leaks", paths: folder.leaks } };\n', ""],
  [STORE, DB_TEST, "a withdrawn folder's files are removed", "    if (row?.storage_prefix != null) await removeFolder(store, row.storage_prefix);\n", ""],
  [FOLDER, DB_TEST, "an excluded kind of file stays out", "out.has(`evidence.${file.fileKind}`)", "false"],
  [FOLDER, DB_TEST, "an excluded folder's files stay out", "const inFolder = file.paths.some(", "const inFolder = false && file.paths.some("],
  [FOLDER, DB_TEST, "the run's name is scrubbed", "`Run: ${t(run.title)}`", "`Run: ${run.title}`"],
  [FOLDER, DB_TEST, "the confirmed cause is scrubbed", '...section("Confirmed cause", t(run.confirmedCause)),', '...section("Confirmed cause", run.confirmedCause),'],
  [FOLDER, DB_TEST, "a file's name is scrubbed", "-${scrubber.fileName(file.originalName)}`", "-${file.originalName}`"],
  [FOLDER, DB_TEST, "a text file's contents are scrubbed", "text: text === null ? null : scrubber.text(text),", "text,"],
  [FOLDER, DB_TEST, "the lab's own name is removed", "removed: [source.lab.name, ...", "removed: [..."],
  [FOLDER, DB_TEST, "an excluded field is left out", '...(out.has("suspected_cause") ? [] : section(', "...(false ? [] : section("],
  [SCRUB, UNIT_TEST, "emails are replaced", '    each(EMAIL, (start, end) => found.push({ start, end, target: { kind: "email" }, rank: 1 }));\n', ""],
  [SCRUB, UNIT_TEST, "patient and donor numbers are replaced", '    each(SUBJECT, (start, end) => found.push({ start, end, target: { kind: "sample" }, rank: 2 }));\n', ""],
  [SCRUB, UNIT_TEST, "accents don't hide a name", '    const bare = c.normalize("NFD").replace(/\\p{M}/gu, "").toLowerCase();', "    const bare = c.toLowerCase();"],
  [SCRUB, UNIT_TEST, "a login names its owner", "        addSingle(p.key, first.charAt(0) + last, first.charAt(0) + last, \"\");\n", ""],
];

// "passed", "failed" (an assertion went red) or "broken" (nothing ran, which proves nothing).
function runTests([project, file]) {
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "--project", project, file], { stdio: "pipe" });
    return "passed";
  } catch (err) {
    if (/Tests\s+\d+ failed/.test(String(err.stdout))) return "failed";
    process.stdout.write(`${String(err.stdout).split("\n").slice(-30).join("\n")}\n${String(err.stderr).split("\n").slice(-10).join("\n")}\n`);
    return "broken";
  }
}

const only = process.argv[2];
let held = 0;
const slipped = [];
for (const [file, tests, name, from, to] of GUARDS) {
  if (only !== undefined && !name.includes(only)) continue;
  const original = readFileSync(file, "utf8");
  if (original.split(from).length !== 2) throw new Error(`"${name}": its text is in the file ${original.split(from).length - 1} times, expected once`);
  let result;
  try {
    writeFileSync(file, original.replace(from, () => to));
    result = runTests(tests);
  } finally {
    writeFileSync(file, original);
  }
  process.stdout.write(`${{ failed: "caught", passed: "MISSED", broken: "BROKE " }[result]} ${name}\n`);
  if (result === "failed") held += 1;
  else slipped.push(name);
}
process.stdout.write(`\n${held} of ${held + slipped.length} broken guards made the tests fail.\n`);
if (slipped.length > 0) process.exit(1);
