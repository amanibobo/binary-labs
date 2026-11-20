-- The debrief of a run that failed or was odd (decisions.md, "the run record: the debrief").
-- Six fixed questions, one answer each: a short recording, whose transcript the worker writes
-- as an extraction exactly as for a talk-through, or typed words. Nothing here is written by a
-- model. Approving copies each answer onto the run as it stands; question 3 becomes the
-- suspected cause only when the scientist ticks it, and the confirmed cause is never touched.
-- The tables are 0034's. Error codes: BL941 the run didn't fail and wasn't odd, BL942 no such
-- debrief, BL943 the debrief is already saved or thrown away, BL944 an answer is still being
-- transcribed, BL945 a recording couldn't be transcribed, BL946 no answer 3 to use as the cause.

-- The newest transcript of a recording, if the worker has written one.
create function debrief_transcript(p_location_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select e.content
  from file_locations fl
  join extractions e on e.sha256 = fl.sha256 and e.kind = 'transcript'
  where fl.id = p_location_id
  order by e.created_at desc
  limit 1
$$;

-- One answer's words as the run would take them: what was typed, else the scientist's own
-- correction of the transcript, else the transcript. Null when there's nothing.
create function debrief_words(a run_debrief_answers) returns text
language sql stable security definer set search_path = public as $$
  select nullif(btrim(case
    when a.typed or a.text is not null then a.text
    when a.location_id is not null then debrief_transcript(a.location_id)
  end), '')
$$;

-- One debrief, whole. A recording's transcript is read from extractions, which members can't
-- read themselves. Not callable by members directly: every caller has checked the lab.
create function debrief_json(p_debrief_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', d.id,
    'run_id', d.run_id,
    'state', d.state,
    'started_by', d.started_by,
    'started_at', d.started_at,
    'approved_at', d.approved_at,
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'question', a.question,
        'typed', a.typed,
        'text', a.text,
        'fix_worked', a.fix_worked,
        'recording', case when fl.id is null then null else jsonb_build_object(
          'location_id', fl.id,
          'index_state', fl.index_state,
          'error', fl.index_error,
          'transcript', debrief_transcript(fl.id)
        ) end
      ) order by a.question)
      from run_debrief_answers a
      left join file_locations fl on fl.id = a.location_id
      where a.debrief_id = d.id
    ), '[]')
  )
  from run_debriefs d
  where d.id = p_debrief_id
$$;

-- The run's open debrief, else the last one saved to it; null if there's neither.
create function run_debrief(p_run_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select debrief_json(d.id)
  from run_debriefs d
  where d.run_id = p_run_id and d.state <> 'discarded' and is_lab_member(d.lab_id)
  order by d.state = 'open' desc, d.approved_at desc
  limit 1
$$;

-- An open debrief, locked with its run, for a change. Not callable by members directly.
create function member_debrief(p_debrief_id uuid) returns run_debriefs
language plpgsql security definer set search_path = public as $$
declare
  v_run uuid;
  d run_debriefs;
begin
  select run_id into v_run from run_debriefs where id = p_debrief_id;
  if not found then
    raise exception 'no such debrief' using errcode = 'BL942';
  end if;
  perform member_run(v_run);
  select * into d from run_debriefs where id = p_debrief_id for update;
  if d.state <> 'open' then
    raise exception 'this debrief is already saved or thrown away' using errcode = 'BL943';
  end if;
  return d;
end
$$;

create function check_question(p_question smallint) returns void
language plpgsql immutable set search_path = public as $$
begin
  if p_question is null or p_question not between 1 and 6 then
    raise exception 'a question is 1 to 6' using errcode = '22023';
  end if;
end
$$;

-- Starts the run's debrief, or returns the one already open.
create function start_debrief(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
  v_id uuid;
begin
  if r.status is distinct from 'failed' and r.status is distinct from 'odd' then
    raise exception 'only a run that failed or was odd has a debrief' using errcode = 'BL941';
  end if;
  select id into v_id from run_debriefs where run_id = r.id and state = 'open';
  if v_id is null then
    insert into run_debriefs (run_id, lab_id, started_by) values (r.id, r.lab_id, auth.uid())
    returning id into v_id;
  end if;
  return debrief_json(v_id);
end
$$;

-- A recording whose bytes are already in the object store, as one question's answer. It
-- replaces whatever that question had, keeping question 5's tap. Called by the upload route,
-- like record_talk_through. Idempotent: the same audio again is the same answer.
create function record_debrief_answer(
  p_debrief_id uuid,
  p_question smallint,
  p_sha256 text,
  p_size bigint,
  p_name text,
  p_uploaded_on date,
  p_modified_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d run_debriefs := member_debrief(p_debrief_id);
  v_location uuid;
begin
  perform check_question(p_question);
  select f.location_id into v_location
  from record_file(d.lab_id, p_sha256, p_size, audio_max_bytes(), p_name, null, 'Debriefs', p_uploaded_on, p_modified_at) f;
  insert into run_debrief_answers (debrief_id, lab_id, question, location_id, text, typed)
  values (d.id, d.lab_id, p_question, v_location, null, false)
  on conflict (debrief_id, question) do update
    set location_id = excluded.location_id, text = null, typed = false, answered_at = now();
  return debrief_json(d.id);
end
$$;

-- Words for one question. Typed: they are the answer, and replace any recording; empty clears
-- the answer. A correction: the scientist's own reading of the recording's transcript, kept
-- beside the recording; the transcript itself again, or nothing, takes the correction back.
create function save_answer_text(p_debrief_id uuid, p_question smallint, p_text text, p_correction boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d run_debriefs := member_debrief(p_debrief_id);
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
  a run_debrief_answers;
  v_state index_state;
begin
  perform check_question(p_question);
  if length(v_text) > 20000 then
    raise exception 'an answer is up to 20,000 characters' using errcode = '22023';
  end if;
  if coalesce(p_correction, false) then
    select * into a from run_debrief_answers
    where debrief_id = d.id and question = p_question and location_id is not null;
    if not found then
      raise exception 'there is no recording to correct' using errcode = '22023';
    end if;
    select index_state into v_state from file_locations where id = a.location_id;
    if v_state = 'pending' then
      raise exception 'this answer is still being transcribed' using errcode = 'BL944';
    end if;
    update run_debrief_answers
    set text = case when v_text is not distinct from nullif(btrim(coalesce(debrief_transcript(a.location_id), '')), '')
      then null else coalesce(v_text, '') end,
      answered_at = now()
    where debrief_id = d.id and question = p_question;
  elsif v_text is null then
    update run_debrief_answers set text = null, typed = true, location_id = null, answered_at = now()
    where debrief_id = d.id and question = p_question and fix_worked is not null;
    delete from run_debrief_answers where debrief_id = d.id and question = p_question and fix_worked is null;
  else
    insert into run_debrief_answers (debrief_id, lab_id, question, location_id, text, typed)
    values (d.id, d.lab_id, p_question, null, v_text, true)
    on conflict (debrief_id, question) do update
      set location_id = null, text = excluded.text, typed = true, answered_at = now();
  end if;
  return debrief_json(d.id);
end
$$;

-- Question 5's tap: did the change fix it? Null takes the tap back.
create function set_debrief_fix(p_debrief_id uuid, p_fix run_fix) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d run_debriefs := member_debrief(p_debrief_id);
begin
  if p_fix is null then
    update run_debrief_answers set fix_worked = null where debrief_id = d.id and question = 5;
    delete from run_debrief_answers
    where debrief_id = d.id and question = 5 and location_id is null and text is null;
  else
    insert into run_debrief_answers (debrief_id, lab_id, question, fix_worked)
    values (d.id, d.lab_id, 5, p_fix)
    on conflict (debrief_id, question) do update set fix_worked = excluded.fix_worked;
  end if;
  return debrief_json(d.id);
end
$$;

-- The scientist saves the debrief to the run. Each answer is copied as it stands, and a
-- question with no answer is saved empty, so the run reads "Missing" for it. Answer 3 becomes
-- the suspected cause only when p_use_as_suspected says so. Returns the run.
create function approve_debrief(p_debrief_id uuid, p_use_as_suspected boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d run_debriefs := member_debrief(p_debrief_id);
  r runs;
  v_words text[] := array[null, null, null, null, null, null]::text[];
  v_fix run_fix;
  a run_debrief_answers;
  v_state index_state;
  v_use boolean := coalesce(p_use_as_suspected, false);
begin
  select * into r from runs where id = d.run_id;
  if r.status is distinct from 'failed' and r.status is distinct from 'odd' then
    raise exception 'only a run that failed or was odd has a debrief' using errcode = 'BL941';
  end if;
  for a in select * from run_debrief_answers where debrief_id = d.id loop
    if a.location_id is not null and not a.typed and a.text is null then
      select index_state into v_state from file_locations where id = a.location_id;
      if v_state = 'pending' then
        raise exception 'an answer is still being transcribed' using errcode = 'BL944';
      end if;
      if v_state = 'failed' then
        raise exception 'a recording couldn''t be transcribed' using errcode = 'BL945';
      end if;
    end if;
    v_words[a.question] := debrief_words(a);
    if a.question = 5 then
      v_fix := a.fix_worked;
    end if;
  end loop;
  if v_use and v_words[3] is null then
    raise exception 'there is no answer to question 3 to use as the cause' using errcode = 'BL946';
  end if;
  if v_use and length(v_words[3]) > 4000 then
    raise exception 'a suspected cause is up to 4,000 characters' using errcode = '22023';
  end if;
  update runs set
    aim = v_words[1],
    expected_seen = v_words[2],
    how_found = v_words[4],
    what_changed = v_words[5],
    fix_worked = v_fix,
    who_else = v_words[6],
    debriefed_at = now(),
    suspected_cause = case when v_use then v_words[3] else suspected_cause end,
    suspected_by = case when v_use then auth.uid() else suspected_by end
  where id = r.id;
  update run_debriefs set state = 'approved', approved_by = auth.uid(), approved_at = now() where id = d.id;
  return run_json(r.id);
end
$$;

-- Throws the open debrief away. Its recordings stay in the lab's files.
create function discard_debrief(p_debrief_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  d run_debriefs := member_debrief(p_debrief_id);
begin
  update run_debriefs set state = 'discarded' where id = d.id;
end
$$;

revoke all on function
  debrief_transcript(uuid), debrief_words(run_debrief_answers), debrief_json(uuid), run_debrief(uuid),
  member_debrief(uuid), check_question(smallint), start_debrief(uuid),
  record_debrief_answer(uuid, smallint, text, bigint, text, date, timestamptz),
  save_answer_text(uuid, smallint, text, boolean), set_debrief_fix(uuid, run_fix),
  approve_debrief(uuid, boolean), discard_debrief(uuid)
from public, anon, authenticated;
grant execute on function
  run_debrief(uuid), start_debrief(uuid),
  record_debrief_answer(uuid, smallint, text, bigint, text, date, timestamptz),
  save_answer_text(uuid, smallint, text, boolean), set_debrief_fix(uuid, run_fix),
  approve_debrief(uuid, boolean), discard_debrief(uuid)
to authenticated;
