import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Proves the People-account tests can fail. Each entry breaks one guard in
// db/migrations/0042_people_accounts.sql, reruns people-accounts.db.test.ts and expects it to go
// red; the migration is put back after every one. Run from apps/web with BL_WEB_TEST_DB set:
//   node scripts/people-accounts-guards.mjs [part of a guard's name]

const migration = fileURLToPath(new URL("../../../db/migrations/0042_people_accounts.sql", import.meta.url));
const original = readFileSync(migration, "utf8");

const GUARDS = [
  ["a name is compared without case, spaces or punctuation", "select lower(regexp_replace(coalesce(p_name, ''), '[^[:alnum:]]+', '', 'g'))", "select lower(btrim(coalesce(p_name, '')))"],
  ["an empty name links nothing", "  if v_key = '' then\n    return null;\n  end if;\n", ""],
  ["joining links only when exactly one row has the name", "  if cardinality(v_rows) is distinct from 1\n", "  if v_rows is null\n"],
  ["joining never takes a row someone has", "\n    or exists (select 1 from people p where p.id = v_rows[1] and p.member_user_id is not null) then", " then"],
  ["joining links at all", "create trigger members_link_person after insert on members\nfor each row execute function members_link_person();", ""],
  ["a link is logged", "  insert into audit_log (lab_id, actor, action, target)\n  values (p_lab_id, auth.uid(), 'person.link'", "  perform (p_lab_id, auth.uid(), 'person.link'"],
  ["a person is one of the caller's lab", "  if not is_lab_member(p.lab_id) then", "  if false then"],
  ["a missing person is said so", "  if not found then\n    raise exception 'no such person' using errcode = 'BL981';\n  end if;\n", ""],
  ["the account is a member of the lab", "  if not found then\n    raise exception 'not a member of this lab' using errcode = 'BL984';\n  end if;\n", ""],
  ["the same link again is a no-op", "  if p.member_user_id is not distinct from p_user_id then\n    return;\n  end if;\n", ""],
  ["a row someone has isn't taken", "  if p.member_user_id is not null then\n    raise exception 'this person is linked to another account'", "  if false then\n    raise exception 'this person is linked to another account'"],
  ["a member is one person", "  if exists (select 1 from people o where o.lab_id = p.lab_id and o.member_user_id = p_user_id and o.id <> p.id) then", "  if false then"],
  ["two claims at once can't both pass", "  perform 1 from members m where m.lab_id = p.lab_id and m.user_id = p_user_id for update;", "  perform 1 from members m where m.lab_id = p.lab_id and m.user_id = p_user_id;"],
  ["only an admin links someone else", "  if not is_lab_admin(p.lab_id) then\n    raise exception 'only admins link other people'", "  if false then\n    raise exception 'only admins link other people'"],
  ["only an admin unlinks", "  if not is_lab_admin(p.lab_id) then\n    raise exception 'only admins unlink people'", "  if false then\n    raise exception 'only admins unlink people'"],
  ["an unlink is logged", "  insert into audit_log (lab_id, actor, action, target)\n  values (p.lab_id, auth.uid(), 'person.unlink'", "  perform (p.lab_id, auth.uid(), 'person.unlink'"],
  ["unlinking says how many yeses it took back", "  select count(*) into v_yeses from runs r", "  select 0 into v_yeses from runs r"],
  ["a link moving away takes back the yeses", "  where lab_id = new.lab_id and confirmed_by = new.id and confirmer_attested_at is not null;", "  where false;"],
  ["the run log says the trigger took them back", "  perform set_config('binary.run_via', 'trigger', true);\n  update runs", "  update runs"],
  ["the People list is the lab's only", "  where p.lab_id = p_lab_id and is_lab_member(p_lab_id)", "  where p.lab_id = p_lab_id"],
  ["leaving failed asks about a failure type", " or r.taxonomy_version is not null)", ")"],
  ["the link helper isn't the members'", "  person_name_key(text), put_person_link(uuid, uuid, uuid), members_link_person()", "  person_name_key(text), members_link_person()"],
  ["the lock helper isn't the members'", "  member_person(uuid), link_checked(people, uuid), claim_person(uuid)", "  link_checked(people, uuid), claim_person(uuid)"],
  ["the check helper isn't the members'", "  member_person(uuid), link_checked(people, uuid), claim_person(uuid)", "  member_person(uuid), claim_person(uuid)"],
  ["the People list is the members'", "  claim_person(uuid), link_person(uuid, uuid), unlink_person(uuid), lab_people(uuid),\n  set_run_status", "  claim_person(uuid), link_person(uuid, uuid), unlink_person(uuid),\n  set_run_status"],
];

// "passed", "failed" (a test's assertion went red) or "broken" (the migration no longer
// applies, which proves nothing about the tests).
function runTests() {
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "--project", "db", "src/lib/__tests__/people-accounts.db.test.ts"], { stdio: "pipe" });
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
