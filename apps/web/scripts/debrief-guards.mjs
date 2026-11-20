import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Proves the debrief's database tests can fail, as run-record-guards.mjs does for 0034. Each
// entry breaks one guard in db/migrations/0038_run_debriefs.sql, reruns debrief.db.test.ts and
// expects it to go red; the migration is put back after every one. From apps/web with
// BL_WEB_TEST_DB set:
//   node scripts/debrief-guards.mjs

const migration = fileURLToPath(new URL("../../../db/migrations/0038_run_debriefs.sql", import.meta.url));
const original = readFileSync(migration, "utf8");

const GUARDS = [
  ["run_debrief checks the lab", "where d.run_id = p_run_id and d.state <> 'discarded' and is_lab_member(d.lab_id)", "where d.run_id = p_run_id and d.state <> 'discarded'"],
  ["a thrown-away debrief isn't the run's", "where d.run_id = p_run_id and d.state <> 'discarded' and", "where d.run_id = p_run_id and"],
  ["a debrief's writes check the lab", "  perform member_run(v_run);\n", "\n"],
  ["no such debrief", "    raise exception 'no such debrief' using errcode = 'BL942';", "    return null;"],
  ["a closed debrief takes no answers", "  if d.state <> 'open' then", "  if false then"],
  ["a question is 1 to 6", "  if p_question is null or p_question not between 1 and 6 then", "  if false then"],
  ["start: only a failed or odd run", "  if r.status is distinct from 'failed' and r.status is distinct from 'odd' then\n    raise exception 'only a run that failed or was odd has a debrief' using errcode = 'BL941';\n  end if;\n  select id into v_id", "  select id into v_id"],
  ["start: one open debrief is reused", "  select id into v_id from run_debriefs where run_id = r.id and state = 'open';\n", "\n"],
  ["a recording goes in the Debriefs folder", "audio_max_bytes(), p_name, null, 'Debriefs',", "audio_max_bytes(), p_name, null, null,"],
  ["a recording replaces typed words", "    set location_id = excluded.location_id, text = null, typed = false, answered_at = now();", "    set location_id = excluded.location_id, answered_at = now();"],
  ["typing replaces a recording", "      set location_id = null, text = excluded.text, typed = true, answered_at = now();", "      set text = excluded.text, answered_at = now();"],
  ["a correction needs a recording", "      raise exception 'there is no recording to correct' using errcode = '22023';", "      return null;"],
  ["a correction waits for the transcript", "    if v_state = 'pending' then\n      raise exception 'this answer is still being transcribed' using errcode = 'BL944';", "    if false then\n      raise exception 'this answer is still being transcribed' using errcode = 'BL944';"],
  ["the transcript again takes a correction back", "    set text = case when v_text is not distinct from", "    set text = case when false and v_text is not distinct from"],
  ["an empty typed answer keeps question 5's tap", "    delete from run_debrief_answers where debrief_id = d.id and question = p_question and fix_worked is null;", "    delete from run_debrief_answers where debrief_id = d.id and question = p_question;"],
  ["taking the tap back keeps the words", "    where debrief_id = d.id and question = 5 and location_id is null and text is null;", "    where debrief_id = d.id and question = 5;"],
  ["approve: only a failed or odd run", "  select * into r from runs where id = d.run_id;\n  if r.status is distinct from 'failed' and r.status is distinct from 'odd' then", "  select * into r from runs where id = d.run_id;\n  if false then"],
  ["approve: waits for transcripts", "      if v_state = 'pending' then\n        raise exception 'an answer is still being transcribed'", "      if false then\n        raise exception 'an answer is still being transcribed'"],
  ["approve: refuses a recording nobody made out", "      if v_state = 'failed' then", "      if false then"],
  ["approve: the tap needs an answer 3", "  if v_use and v_words[3] is null then", "  if false then"],
  ["approve: no cause without the tap", "    suspected_cause = case when v_use then v_words[3] else suspected_cause end,", "    suspected_cause = coalesce(v_words[3], suspected_cause),"],
  ["approve: the correction wins over the transcript", "    when a.typed or a.text is not null then a.text", "    when a.typed then a.text"],
  ["approve: an unanswered question is saved empty", "    who_else = v_words[6],", "    who_else = coalesce(v_words[6], who_else),"],
  ["approve: question 5's tap reaches the run", "    fix_worked = v_fix,", ""],
  ["approve: the debrief is closed", "  update run_debriefs set state = 'approved', approved_by = auth.uid(), approved_at = now() where id = d.id;", ""],
  ["the helpers aren't the members'", "  run_debrief(uuid), start_debrief(uuid),\n  record_debrief_answer(uuid, smallint, text, bigint, text, date, timestamptz),\n  save_answer_text(uuid, smallint, text, boolean), set_debrief_fix(uuid, run_fix),\n  approve_debrief(uuid, boolean), discard_debrief(uuid)\nto authenticated;", "  run_debrief(uuid), start_debrief(uuid), member_debrief(uuid), debrief_json(uuid), debrief_transcript(uuid),\n  record_debrief_answer(uuid, smallint, text, bigint, text, date, timestamptz),\n  save_answer_text(uuid, smallint, text, boolean), set_debrief_fix(uuid, run_fix),\n  approve_debrief(uuid, boolean), discard_debrief(uuid)\nto authenticated;"],
];

// "passed", "failed" (a test's assertion went red) or "broken" (the migration no longer
// applies, which proves nothing about the tests).
function runTests() {
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "--project", "db", "src/lib/__tests__/debrief.db.test.ts"], { stdio: "pipe" });
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
