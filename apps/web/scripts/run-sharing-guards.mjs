import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Proves the sharing tests can fail. Each entry breaks one guard in
// db/migrations/0037_run_sharing.sql, reruns run-sharing.db.test.ts and expects it to go red;
// the migration is put back after every one. Run from apps/web with BL_WEB_TEST_DB set:
//   node scripts/run-sharing-guards.mjs

const migration = fileURLToPath(new URL("../../../db/migrations/0037_run_sharing.sql", import.meta.url));
const original = readFileSync(migration, "utf8");

const GUARDS = [
  ["gate: an unattested confirmed cause blocks", "\n    || case when r.confirmed_cause is not null and r.confirmer_attested_at is null then array['not_attested'] else '{}' end", ""],
  ["gate: a blocked run gets no grant", "  if cardinality(v_blocks) > 0 then", "  if false then"],
  ["gate: the caller is a member of the run's lab", "    r := member_run(p_run_id);\n  exception", "    select * into r from runs where id = p_run_id;\n    if not found then raise exception 'x' using errcode = 'BL907'; end if;\n  exception"],
  ["gate: an outsider's attempt is logged", "      if v_lab is not null then", "      if false then"],
  ["run switch: starts with member_run", "  r runs := member_run(p_run_id);\n  v_on", "  r runs := (select x from runs x where x.id = p_run_id);\n  v_on"],
  ["run switch: the person who ran it or an admin", "  if not can_share_run(r.lab_id, r.person_id) then", "  if false then"],
  ["run switch: an admin, not any member", "  select is_lab_admin(p_lab_id) or exists (", "  select is_lab_member(p_lab_id) or exists ("],
  ["run switch: the runner's own account", " and p.member_user_id = auth.uid()", ""],
  ["run switch: never on in a demo lab", "  if v_on and exists (select 1 from labs where id = r.lab_id and plan = 'demo') then", "  if false then"],
  ["run switch: off after a folder logs that sent copies stay out", "  if not v_on and v_built > 0 then", "  if false then"],
  ["run sharing is read by its lab only", "  from runs r where r.id = p_run_id and is_lab_member(r.lab_id)", "  from runs r where r.id = p_run_id"],
  ["lab agreement: admins only", "  if auth.uid() is null or not is_lab_admin(p_lab_id) then\n    raise exception 'admins only'", "  if false then\n    raise exception 'admins only'"],
  ["lab agreement: never on in a demo lab", "    if l.plan = 'demo' then", "    if false then"],
  ["lab agreement: the wording's version is stored", "    if v_agreement is null or length(v_agreement) > 100 then", "    if false then"],
  ["lab agreement: a version is short", "    if v_agreement is null or length(v_agreement) > 100 then", "    if v_agreement is null then"],
  ["lab agreement: agreeing again changes nothing", "    where id = l.id and sharing_agreement is distinct from v_agreement;", "    where id = l.id;"],
  ["lab agreement: off after a folder logs that sent copies stay out", "    if v_built > 0 then", "    if false then"],
  ["lab sharing is read by its lab only", "  from labs l where l.id = p_lab_id and is_lab_member(l.id)", "  from labs l where l.id = p_lab_id"],
  ["log: members and admins only", "    or not (case when p_run_id is null then is_lab_admin(p_lab_id) else is_lab_member(p_lab_id) end) then", "    or false then"],
  ["log: the lab's is an admin's", "case when p_run_id is null then is_lab_admin(p_lab_id) else", "case when p_run_id is null then is_lab_member(p_lab_id) else"],
  ["log: rows of the lab asked about", "  where l.lab_id = p_lab_id\n", "  where true\n"],
  ["log: sharing rows only", "    and l.action in ('run.share', 'lab.share', 'export.allowed', 'export.blocked')\n", ""],
  ["log: a run's log is that run's", "    and (p_run_id is null or l.run_id = p_run_id)\n", ""],
  ["log: no name for someone outside the lab", "from auth.users u join members m on m.user_id = u.id where m.lab_id = l.lab_id and u.id = l.actor", "from auth.users u where u.id = l.actor"],
  ["the helpers aren't the members'", "  run_share_blocks(uuid), can_share_run(uuid, uuid), lab_sharing(uuid), run_sharing(uuid),\n  set_run_share", "  lab_sharing(uuid), run_sharing(uuid),\n  set_run_share"],
];

// "passed", "failed" (a test's assertion went red) or "broken" (the migration no longer
// applies, which proves nothing about the tests).
function runTests() {
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "--project", "db", "src/lib/__tests__/run-sharing.db.test.ts"], { stdio: "pipe" });
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
