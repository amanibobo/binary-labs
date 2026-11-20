-- Labels and notes (decisions.md, "labels on many files, skipped questions and repeats"):
-- one change to many files' labels at once, undone together; a voice note's question skipped
-- without an answer; and a repeat run linked to the run it repeats, so each shows the other.
-- Additive: one column on labels and on corrections, one table, new functions, and label_json
-- with the new fields.

-- A skipped question stays stored but is no longer asked; un-skipping brings it back. It sits
-- beside follow_up rather than clearing it, so a label's recorded state (label_state, which
-- corrections compare for undo) doesn't change when a question is skipped, and the worker
-- re-labeling a guessed label can't ask it again.
alter table labels add column follow_up_skipped_at timestamptz;

-- The corrections one change to many files made, so they're undone together.
alter table corrections add column batch_id uuid;
create index corrections_batch_idx on corrections (batch_id) where batch_id is not null;

-- A repeat run and the run it repeats. A run repeats at most one earlier run; a run can be
-- repeated many times. Both are labeled files of the same lab.
create table run_repeats (
  lab_id uuid not null,
  sha256 text not null,
  repeats text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (lab_id, sha256),
  check (sha256 <> repeats),
  foreign key (lab_id, sha256) references labels (lab_id, sha256) on delete cascade,
  foreign key (lab_id, repeats) references labels (lab_id, sha256) on delete cascade
);
create index run_repeats_repeats_idx on run_repeats (lab_id, repeats);
alter table run_repeats enable row level security;
create policy run_repeats_select on run_repeats for select using (is_lab_member(lab_id));

-- A file as another label points at it: its hash and the name its row shows.
create function label_ref_json(p_lab_id uuid, p_sha256 text) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'sha256', l.sha256,
    'name', coalesce(l.clean_name, live_locations_json(p_lab_id, l.sha256) -> 0 ->> 'original_name', l.sha256)
  )
  from labels l where l.lab_id = p_lab_id and l.sha256 = p_sha256
$$;

-- 0025's label_json with a skipped question left out, and the repeat links both ways.
create or replace function label_json(p_lab_id uuid, p_sha256 text) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'status', l.status,
    'clean_name', l.clean_name,
    'date', l.date,
    'experiment', case when e.id is null then null
      else jsonb_build_object('id', e.id, 'name', e.name) end,
    'person', case when p.id is null then null
      else jsonb_build_object('id', p.id, 'name', p.display_name) end,
    'instrument', l.instrument,
    'tags', to_jsonb(l.tags),
    'confidence', l.confidence,
    'outcome', l.outcome,
    'summary', l.summary,
    'conditions', l.conditions,
    'note_kind', l.note_kind,
    'alternatives', to_jsonb(l.alternatives),
    'unclear', to_jsonb(l.unclear),
    'follow_up', case when l.follow_up_skipped_at is null then l.follow_up end,
    'note', note_json(p_lab_id, p_sha256),
    'repeat_of', (
      select label_ref_json(p_lab_id, r.repeats) from run_repeats r where r.lab_id = p_lab_id and r.sha256 = p_sha256
    ),
    'repeated_in', coalesce((
      select jsonb_agg(label_ref_json(p_lab_id, r.sha256) order by r.created_at, r.sha256)
      from run_repeats r where r.lab_id = p_lab_id and r.repeats = p_sha256
    ), '[]')
  )
  from labels l
  left join experiments e on e.id = l.experiment_id
  left join people p on p.id = l.person_id
  where l.lab_id = p_lab_id and l.sha256 = p_sha256
$$;

-- Skips a voice note's question (p_skipped) or asks it again, returning the label.
-- BL001: no label for this file.
create function skip_follow_up(p_lab_id uuid, p_sha256 text, p_skipped boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  update labels set follow_up_skipped_at = case when p_skipped then coalesce(follow_up_skipped_at, now()) end
  where lab_id = p_lab_id and sha256 = p_sha256;
  if not found then
    raise exception 'no label for this file yet' using errcode = 'BL001';
  end if;
  return label_json(p_lab_id, p_sha256);
end
$$;

-- One change to many files' labels, as one correction per file that it changes, sharing a
-- batch id. p_change is {field, value}: experiment or person (an id of this lab's, or null to
-- clear), instrument (text or null), date (YYYY-MM-DD or null), outcome (a label_outcome or
-- null), add_tag or remove_tag (a tag). Mirrors bulkDraft in apps/web/src/lib/bulk-labels.ts.
-- A file is left out when it already has the value ("same"), has no name yet ("unnamed": no
-- label, or in Needs a look), or already has 20 tags ("full"). Returns
-- {batch_id, changed: [{sha256, correction_id, label}], same, unnamed, full}.
-- Errors: BL801 a change it doesn't know, BL802 an experiment or person not in this lab,
-- BL803 more than 200 files.
create function correct_labels(p_lab_id uuid, p_shas text[], p_change jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_field text := p_change ->> 'field';
  v_value text := nullif(btrim(p_change ->> 'value'), '');
  v_batch uuid := gen_random_uuid();
  v_sha text;
  cur record;
  v_after jsonb;
  v_same boolean;
  v_id bigint;
  v_changed jsonb := '[]';
  n_same int := 0;
  n_unnamed int := 0;
  n_full int := 0;
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_shas), 0) > 200 then
    raise exception 'change up to 200 files at once' using errcode = 'BL803';
  end if;
  if jsonb_typeof(p_change) <> 'object'
    or v_field is null
    or v_field not in ('experiment', 'person', 'instrument', 'date', 'outcome', 'add_tag', 'remove_tag')
    or (v_field in ('add_tag', 'remove_tag') and (v_value is null or length(v_value) > 200))
    or (v_field = 'instrument' and length(v_value) > 120)
    or (v_field = 'date' and v_value is not null and v_value !~ '^\d{4}-\d{2}-\d{2}$')
    or (v_field = 'outcome' and v_value is not null and v_value not in ('worked', 'failed', 'repeat', 'final', 'unclear'))
    or (v_field in ('experiment', 'person') and v_value is not null
      and v_value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  then
    raise exception 'unknown change: %', p_change using errcode = 'BL801';
  end if;
  if v_field = 'experiment' and v_value is not null
    and not exists (select 1 from experiments where id = v_value::uuid and lab_id = p_lab_id) then
    raise exception 'no such experiment in this lab' using errcode = 'BL802';
  end if;
  if v_field = 'person' and v_value is not null
    and not exists (select 1 from people where id = v_value::uuid and lab_id = p_lab_id) then
    raise exception 'no such person in this lab' using errcode = 'BL802';
  end if;
  if v_field = 'date' and v_value is not null then
    v_value := v_value::date::text;
  end if;

  for v_sha in select s from unnest(p_shas) with ordinality as t (s, ord) group by s order by min(ord) loop
    select l.status, l.clean_name, l.date, l.experiment_id, l.person_id, l.instrument, l.tags, l.outcome into cur
    from labels l where l.lab_id = p_lab_id and l.sha256 = v_sha;
    if not found or cur.status = 'needs_look' or cur.clean_name is null then
      n_unnamed := n_unnamed + 1;
      continue;
    end if;
    v_same := case v_field
      when 'experiment' then cur.experiment_id is not distinct from v_value::uuid
      when 'person' then cur.person_id is not distinct from v_value::uuid
      when 'instrument' then cur.instrument is not distinct from v_value
      when 'date' then cur.date is not distinct from v_value::date
      when 'outcome' then cur.outcome is not distinct from v_value::label_outcome
      when 'add_tag' then v_value = any (cur.tags)
      when 'remove_tag' then not (v_value = any (cur.tags))
    end;
    if v_same then
      n_same := n_same + 1;
      continue;
    end if;
    if v_field = 'add_tag' and cardinality(cur.tags) >= 20 then
      n_full := n_full + 1;
      continue;
    end if;
    v_after := jsonb_build_object(
      'clean_name', cur.clean_name,
      'date', cur.date,
      'experiment_id', cur.experiment_id,
      'person_id', cur.person_id,
      'instrument', cur.instrument,
      'tags', to_jsonb(cur.tags)
    ) || case v_field
      when 'experiment' then jsonb_build_object('experiment_id', v_value)
      when 'person' then jsonb_build_object('person_id', v_value)
      when 'instrument' then jsonb_build_object('instrument', v_value)
      when 'date' then jsonb_build_object('date', v_value)
      when 'outcome' then jsonb_build_object('outcome', v_value)
      when 'add_tag' then jsonb_build_object('tags', to_jsonb(cur.tags || v_value))
      when 'remove_tag' then jsonb_build_object('tags', to_jsonb(array_remove(cur.tags, v_value)))
    end;
    insert into corrections (lab_id, sha256, after, batch_id)
    values (p_lab_id, v_sha, v_after, v_batch)
    returning id into v_id;
    v_changed := v_changed || jsonb_build_array(jsonb_build_object(
      'sha256', v_sha, 'correction_id', v_id, 'label', label_json(p_lab_id, v_sha)
    ));
  end loop;
  return jsonb_build_object(
    'batch_id', case when jsonb_array_length(v_changed) > 0 then v_batch end,
    'changed', v_changed,
    'same', n_same,
    'unnamed', n_unnamed,
    'full', n_full
  );
end
$$;

-- Undoes what one correct_labels call changed, file by file. A file whose label changed since
-- keeps its newer label and is counted as skipped. Returns
-- {undone: [{sha256, correction_id, label}], skipped}. BL002: nothing of the caller's to undo.
create function undo_label_batch(p_lab_id uuid, p_batch_id uuid) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  c record;
  v_id bigint;
  v_undone jsonb := '[]';
  n_skipped int := 0;
  n_found int := 0;
begin
  for c in
    select id, lab_id, sha256 from corrections
    where lab_id = p_lab_id and batch_id = p_batch_id and undoes is null and user_id = auth.uid()
    order by id
  loop
    n_found := n_found + 1;
    if exists (select 1 from corrections u where u.undoes = c.id) then
      n_skipped := n_skipped + 1;
      continue;
    end if;
    begin
      insert into corrections (lab_id, sha256, after, undoes)
      values (c.lab_id, c.sha256, '{}', c.id)
      returning id into v_id;
      v_undone := v_undone || jsonb_build_array(jsonb_build_object(
        'sha256', c.sha256, 'correction_id', v_id, 'label', label_json(p_lab_id, c.sha256)
      ));
    exception when sqlstate 'BL004' then
      n_skipped := n_skipped + 1;
    end;
  end loop;
  if n_found = 0 then
    raise exception 'nothing to undo' using errcode = 'BL002';
  end if;
  return jsonb_build_object('undone', v_undone, 'skipped', n_skipped);
end
$$;

-- Links a repeat run to the run it repeats (p_repeats), or unlinks it (null), returning the
-- repeat's label. Errors: BL811 a file that isn't a labeled file of this lab, BL812 a run
-- linked to itself or to a run that repeats it (a loop).
create function link_repeat(p_lab_id uuid, p_sha256 text, p_repeats text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  if not exists (select 1 from labels where lab_id = p_lab_id and sha256 = p_sha256 and clean_name is not null)
    or (p_repeats is not null
      and not exists (select 1 from labels where lab_id = p_lab_id and sha256 = p_repeats and clean_name is not null))
  then
    raise exception 'pick a labeled file from this lab' using errcode = 'BL811';
  end if;
  if p_repeats is null then
    delete from run_repeats where lab_id = p_lab_id and sha256 = p_sha256;
    return label_json(p_lab_id, p_sha256);
  end if;
  if p_repeats = p_sha256 or exists (
    with recursive up (sha) as (
      select p_repeats
      union
      select r.repeats from run_repeats r join up on r.sha256 = up.sha where r.lab_id = p_lab_id
    )
    select 1 from up where sha = p_sha256
  ) then
    raise exception 'a run can''t repeat itself' using errcode = 'BL812';
  end if;
  insert into run_repeats (lab_id, sha256, repeats, created_by)
  values (p_lab_id, p_sha256, p_repeats, auth.uid())
  on conflict (lab_id, sha256) do update
    set repeats = excluded.repeats, created_by = excluded.created_by, created_at = now();
  return label_json(p_lab_id, p_sha256);
end
$$;

-- The runs a repeat might repeat: labeled files of the lab other than itself and the runs
-- that repeat it, those of its experiment first, then by how close their day is, newest
-- first. p_query narrows to names holding every word.
create function repeat_candidates(p_lab_id uuid, p_sha256 text, p_query text, p_limit int default 8)
returns table (sha256 text, name text, date date, experiment text, outcome label_outcome)
language sql stable security invoker set search_path = public as $$
  with me as (select experiment_id, date from labels where lab_id = p_lab_id and sha256 = p_sha256),
  words as (select w from regexp_split_to_table(lower(btrim(coalesce(p_query, ''))), '\s+') w where w <> '')
  select l.sha256, l.clean_name, l.date, e.name, l.outcome
  from labels l
  left join experiments e on e.id = l.experiment_id
  left join me on true
  where l.lab_id = p_lab_id
    and l.sha256 <> p_sha256
    and l.clean_name is not null
    and l.status <> 'needs_look'
    and exists (select 1 from file_locations fl where fl.lab_id = p_lab_id and fl.sha256 = l.sha256 and fl.deleted_at is null)
    and not exists (select 1 from run_repeats r where r.lab_id = p_lab_id and r.sha256 = l.sha256 and r.repeats = p_sha256)
    and not exists (select 1 from words where strpos(lower(l.clean_name), words.w) = 0)
  order by
    coalesce(l.experiment_id = me.experiment_id, false) desc,
    abs(coalesce(l.date, '1900-01-01'::date) - coalesce(me.date, current_date)),
    l.date desc nulls last,
    l.clean_name
  limit least(greatest(p_limit, 1), 20)
$$;

revoke all on run_repeats from anon, authenticated;
revoke all on function
  label_ref_json(uuid, text), skip_follow_up(uuid, text, boolean), correct_labels(uuid, text[], jsonb),
  undo_label_batch(uuid, uuid), link_repeat(uuid, text, text), repeat_candidates(uuid, text, text, int)
from public, anon, authenticated;

grant select (follow_up_skipped_at) on labels to authenticated;
grant select (batch_id) on corrections to authenticated;
grant insert (batch_id) on corrections to authenticated;
grant select on run_repeats to authenticated;
grant execute on function
  label_ref_json(uuid, text), skip_follow_up(uuid, text, boolean), correct_labels(uuid, text[], jsonb),
  undo_label_batch(uuid, uuid), link_repeat(uuid, text, text), repeat_candidates(uuid, text, text, int)
to authenticated;
