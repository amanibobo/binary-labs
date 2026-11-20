-- The task folder (decisions.md, "the run record: de-identification and the task folder").
-- Functions only: every table here is from 0034. A second scientist writes the question, the
-- rubric and review notes for a run whose cause is confirmed and attested; the web app then
-- builds a de-identified folder and records it with build_task_export, which refuses and logs
-- anything that may not leave. 0034's trigger on task_exports still has the last word on
-- consent and the grant.
--
-- Errors: BL961 the reviewer ran this run or isn't one of the lab's people, BL962 the cause
-- isn't confirmed and attested yet, BL963 the rubric isn't a list of criteria with points,
-- BL964 no such folder, BL965 the folder isn't withdrawn, BL966 not something a lab can leave
-- out.

-- What a run still lacks before it can become a task. Empty when it lacks nothing; null when
-- there is no such run. The one place readiness is written.
create function task_export_gaps(p_run_id uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select array_remove(array[
    case when r.confirmed_cause is null then 'no_confirmed_cause' end,
    case when r.confirmed_cause is not null and r.confirmer_attested_at is null then 'not_attested' end,
    case when not exists (select 1 from run_rubrics q where q.run_id = r.id and jsonb_array_length(q.rubric) > 0)
      then 'no_task' end,
    case when not exists (
      select 1 from run_reviews v
      where v.run_id = r.id and v.reviewer_id is not null and v.reviewer_id is distinct from r.person_id
    ) then 'no_review' end,
    case when r.as_run_body is null and r.planned_version_id is null then 'no_protocol' end,
    case when exists (
      select 1 from run_files f
      where f.run_id = r.id and not exists (
        select 1 from file_versions fv
        where fv.lab_id = f.lab_id and fv.sha256 = f.sha256 and fv.kept_at is not null
      )
    ) then 'file_not_kept' end,
    case when exists (
      select 1 from export_exclusions x
      where x.lab_id = r.lab_id and x.kind = 'experiment' and x.value = r.experiment_id::text
    ) then 'excluded_experiment' end
  ], null)
  from runs r
  where r.id = p_run_id
$$;

-- The task as its page shows it: what is written, what is missing, what the lab leaves out
-- and the folders built so far. Null for another lab's run.
create function run_task_json(p_run_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'run_id', r.id,
    'question', q.question,
    'rubric', coalesce(q.rubric, '[]'),
    'written_at', q.updated_at,
    'review', (
      select jsonb_build_object(
        'reviewer', case when p.id is null then null else jsonb_build_object('id', p.id, 'name', p.display_name) end,
        'notes', v.notes, 'agrees', v.agrees, 'reviewed_at', v.reviewed_at
      )
      from run_reviews v left join people p on p.id = v.reviewer_id
      where v.run_id = r.id
      order by v.reviewed_at desc, v.id
      limit 1
    ),
    'ran_by', r.person_id,
    'gaps', task_export_gaps(r.id),
    'blocks', run_export_blocks(r.id),
    'demo', l.plan = 'demo',
    'can_exclude', is_lab_admin(r.lab_id),
    'exclusions', coalesce((
      select jsonb_agg(jsonb_build_object('kind', x.kind, 'value', x.value) order by x.kind, x.value)
      from export_exclusions x where x.lab_id = r.lab_id
    ), '[]'),
    'exports', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'built_at', t.built_at, 'withdrawn_at', t.withdrawn_at,
        'has_files', t.storage_prefix is not null,
        'files', coalesce(jsonb_array_length(t.manifest -> 'evidence'), 0),
        'bytes', t.manifest -> 'zip' -> 'bytes'
      ) order by t.built_at desc, t.id)
      from task_exports t where t.run_id = r.id
    ), '[]')
  )
  from runs r
  join labs l on l.id = r.lab_id
  left join run_rubrics q on q.run_id = r.id
  where r.id = p_run_id and is_lab_member(r.lab_id)
$$;

-- The second scientist writes the task: the question, the rubric (a list of
-- {criterion, points}) and their review of the confirmed cause. One review per reviewer; saving
-- again replaces theirs. BL961, BL962, BL963 as above.
create function save_run_task(
  p_run_id uuid, p_question text, p_rubric jsonb, p_reviewer_id uuid, p_notes text, p_agrees boolean
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs;
begin
  r := member_run(p_run_id);
  if r.confirmed_cause is null or r.confirmer_attested_at is null then
    raise exception 'the cause isn''t confirmed and attested yet' using errcode = 'BL962';
  end if;
  if p_reviewer_id is null or p_reviewer_id is not distinct from r.person_id
    or not exists (select 1 from people where id = p_reviewer_id and lab_id = r.lab_id) then
    raise exception 'the reviewer is someone else in this lab''s people' using errcode = 'BL961';
  end if;
  if p_rubric is null or jsonb_typeof(p_rubric) <> 'array' or jsonb_array_length(p_rubric) not between 1 and 20
    or exists (
      select 1 from jsonb_array_elements(p_rubric) e
      where jsonb_typeof(e) <> 'object'
        or jsonb_typeof(e -> 'criterion') is distinct from 'string'
        or length(btrim(e ->> 'criterion')) not between 1 and 500
        or not coalesce('[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]'::jsonb @> (e -> 'points'), false)
        or (select count(*) from jsonb_object_keys(e)) <> 2
    ) then
    raise exception 'a rubric is 1 to 20 criteria, each with 1 to 10 points' using errcode = 'BL963';
  end if;
  insert into run_rubrics (run_id, lab_id, question, rubric, written_by, updated_at)
  values (r.id, r.lab_id, btrim(p_question), p_rubric, auth.uid(), now())
  on conflict (run_id) do update
    set question = excluded.question, rubric = excluded.rubric, written_by = excluded.written_by, updated_at = now();
  delete from run_reviews where run_id = r.id and reviewer_id = p_reviewer_id;
  insert into run_reviews (run_id, lab_id, reviewer_id, notes, agrees, recorded_by)
  values (r.id, r.lab_id, p_reviewer_id, btrim(p_notes), p_agrees, auth.uid());
  return run_task_json(r.id);
end
$$;

-- Everything the folder is built from, names included: the web app de-identifies it before a
-- byte is written (lib/deidentify.ts). `people` is every name the lab knows, so each can be
-- found and replaced; `log` says who changed what and when, without the values.
create function task_export_source(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs;
begin
  r := member_run(p_run_id);
  return (
    select jsonb_build_object(
      'run', jsonb_build_object(
        'id', r.id, 'title', r.title, 'started_on', r.started_on, 'ended_on', r.ended_on,
        'status', r.status, 'status_by', r.status_by, 'status_at', r.status_at,
        'experiment', (select e.name from experiments e where e.id = r.experiment_id),
        'person_id', r.person_id,
        'retry_of', r.retry_of,
        'suspected_cause', r.suspected_cause,
        'confirmed_cause', r.confirmed_cause,
        'confirmed_by', r.confirmed_by,
        'confirm_method', r.confirm_method,
        'confirm_note', r.confirm_note,
        'confirm_run', r.confirm_run,
        'confirm_sha256', r.confirm_sha256,
        'confirmed_at', r.confirmed_at,
        'confirm_recorded_by', r.confirm_recorded_by,
        'confirmer_attested_at', r.confirmer_attested_at,
        'taxonomy_version', r.taxonomy_version,
        'technique', (select jsonb_build_object('code', t.code, 'label', t.label) from failure_terms t
          where t.version = r.taxonomy_version and t.code = r.technique),
        'failed_step', (select jsonb_build_object('code', t.code, 'label', t.label) from failure_terms t
          where t.version = r.taxonomy_version and t.code = r.failed_step),
        'cause_category', (select jsonb_build_object('code', t.code, 'label', t.label) from failure_terms t
          where t.version = r.taxonomy_version and t.code = r.cause_category),
        'aim', r.aim, 'expected_seen', r.expected_seen, 'how_found', r.how_found,
        'what_changed', r.what_changed, 'fix_worked', r.fix_worked, 'who_else', r.who_else,
        'as_run_body', r.as_run_body, 'as_run_by', r.as_run_by, 'as_run_at', r.as_run_at
      ),
      'planned', (
        select jsonb_build_object('title', pv.title, 'version', pv.version, 'body', pv.body)
        from protocol_versions pv where pv.id = r.planned_version_id
      ),
      'task', (
        select jsonb_build_object(
          'question', q.question, 'rubric', q.rubric, 'written_by', q.written_by, 'written_at', q.updated_at
        )
        from run_rubrics q where q.run_id = r.id
      ),
      'reviews', coalesce((
        select jsonb_agg(jsonb_build_object(
          'reviewer_id', v.reviewer_id, 'notes', v.notes, 'agrees', v.agrees,
          'recorded_by', v.recorded_by, 'reviewed_at', v.reviewed_at
        ) order by v.reviewed_at, v.id)
        from run_reviews v where v.run_id = r.id
      ), '[]'),
      'files', coalesce((
        select jsonb_agg(jsonb_build_object(
          'sha256', f.sha256, 'role', f.role, 'file_kind', b.file_kind, 'mime', b.mime, 'size', b.size,
          'original_name', coalesce(v.original_name, f.sha256), 'kept', coalesce(v.kept, false),
          'paths', coalesce(v.paths, '{}')
        ) order by f.position, f.added_at, f.sha256)
        from run_files f
        join blobs b on b.sha256 = f.sha256
        left join lateral (
          select (array_agg(fv.original_name order by fv.seen_at desc, fv.id))[1] as original_name,
            bool_or(fv.kept_at is not null) as kept,
            array_agg(distinct fv.path) as paths
          from file_versions fv where fv.lab_id = f.lab_id and fv.sha256 = f.sha256
        ) v on true
        where f.run_id = r.id
      ), '[]'),
      'log', coalesce((
        select jsonb_agg(jsonb_build_object(
          'at', g.at, 'action', g.action, 'via', g.via, 'actor', g.actor,
          'changed', case when g.after is null then '[]'::jsonb
            else (select coalesce(jsonb_agg(k order by k), '[]') from jsonb_object_keys(g.after) k) end,
          'share', g.after -> 'share'
        ) order by g.id)
        from run_log g
        where g.run_id = r.id and g.action in ('run.create', 'run.edit', 'run.files', 'run.share')
      ), '[]'),
      'people', coalesce((
        select jsonb_agg(k) from (
          select jsonb_build_object(
            'person_id', p.id, 'user_id', p.member_user_id,
            'names', array_prepend(p.display_name, p.aliases),
            'emails', coalesce((select array_agg(u.email::text) from auth.users u
              where u.id = p.member_user_id and u.email is not null), '{}')
          ) as k
          from people p where p.lab_id = r.lab_id
          union all
          select jsonb_build_object(
            'person_id', null, 'user_id', m.user_id,
            'names', array_remove(array[u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name'], null),
            'emails', array_remove(array[u.email::text], null)
          )
          from members m join auth.users u on u.id = m.user_id
          where m.lab_id = r.lab_id
            and not exists (select 1 from people p where p.lab_id = m.lab_id and p.member_user_id = m.user_id)
        ) known
      ), '[]'),
      'lab', jsonb_build_object(
        'name', l.name, 'demo', l.plan = 'demo',
        'agreement', l.sharing_agreement, 'agreed_at', l.sharing_agreed_at, 'agreed_by', l.sharing_agreed_by
      ),
      'exclusions', coalesce((
        select jsonb_agg(jsonb_build_object('kind', x.kind, 'value', x.value) order by x.kind, x.value)
        from export_exclusions x where x.lab_id = r.lab_id
      ), '[]'),
      'blocks', run_export_blocks(r.id),
      'gaps', task_export_gaps(r.id)
    )
    from labs l where l.id = r.lab_id
  );
end
$$;

-- Records a folder the web app has built and put in the store at <lab>/exports/<id>. It
-- answers, it doesn't raise, so a refusal's log row survives: {kind: 'built', id, prefix} or
-- {kind: 'blocked', reasons}. Refused while sharing is off (run_off, lab_off, demo_lab), while
-- the task lacks something (task_export_gaps), and when 0034's trigger refuses the grant
-- (no_grant). Every refusal is a run_log 'export.blocked' row and an audit row.
create function build_task_export(
  p_run_id uuid, p_export_id uuid, p_grant_id bigint, p_purpose text, p_manifest jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs;
  v_reasons text[];
  v_prefix text;
begin
  r := member_run(p_run_id);
  v_prefix := r.lab_id || '/exports/' || p_export_id;
  v_reasons := run_export_blocks(r.id) || task_export_gaps(r.id);
  if cardinality(v_reasons) = 0 then
    begin
      insert into task_exports (id, lab_id, run_id, grant_id, purpose, taxonomy_version, storage_prefix, manifest, built_by)
      values (p_export_id, r.lab_id, r.id, p_grant_id, p_purpose, r.taxonomy_version, v_prefix, p_manifest, auth.uid());
      return jsonb_build_object('kind', 'built', 'id', p_export_id, 'prefix', v_prefix);
    exception
      when sqlstate 'BL951' then v_reasons := run_export_blocks(r.id);
      when sqlstate 'BL952' or unique_violation or not_null_violation then v_reasons := array['no_grant'];
    end;
  end if;
  insert into run_log (lab_id, run_id, actor, via, action, after)
  values (r.lab_id, r.id, auth.uid(), run_via(), 'export.blocked',
    jsonb_build_object('reasons', v_reasons, 'purpose', p_purpose, 'stage', 'build'));
  insert into audit_log (lab_id, actor, action, target) values (r.lab_id, auth.uid(), 'run.export_blocked', r.id::text);
  return jsonb_build_object('kind', 'blocked', 'reasons', v_reasons);
end
$$;

-- One built folder, to hand it over or to remove it. No row for another run's folder or
-- another lab's.
create function task_export_file(p_run_id uuid, p_export_id uuid)
returns table (lab_id uuid, storage_prefix text, withdrawn_at timestamptz, manifest jsonb)
language sql stable security definer set search_path = public as $$
  select t.lab_id, t.storage_prefix, t.withdrawn_at, t.manifest
  from task_exports t
  where t.id = p_export_id and t.run_id = p_run_id and is_lab_member(t.lab_id)
$$;

-- After a withdrawn folder's files are gone from the store, forget where they were. BL964: no
-- such folder. BL965: it isn't withdrawn, so its files stay.
create function forget_task_export_files(p_run_id uuid, p_export_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  r runs;
  t task_exports;
begin
  r := member_run(p_run_id);
  select * into t from task_exports where id = p_export_id and run_id = r.id;
  if not found then
    raise exception 'no such folder' using errcode = 'BL964';
  end if;
  if t.withdrawn_at is null then
    raise exception 'this folder isn''t withdrawn' using errcode = 'BL965';
  end if;
  update task_exports set storage_prefix = null where id = t.id;
end
$$;

-- An admin says what the lab leaves out of anything exported, or takes that back. `field` is
-- a part of the record or a kind of evidence file (lib/task-folder.ts lists them), `text` a
-- word or phrase to remove wherever it appears, `folder` a folder whose files stay behind and
-- `experiment` an experiment whose runs never leave. BL966: not one of those.
create function set_export_exclusion(p_lab_id uuid, p_kind text, p_value text, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not is_lab_admin(p_lab_id) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('field', 'text', 'folder', 'experiment')
    or length(btrim(coalesce(p_value, ''))) not between 1 and 400
    or (p_kind = 'experiment' and not exists (
      select 1 from experiments e where e.lab_id = p_lab_id and e.id::text = btrim(p_value)
    )) then
    raise exception 'not something a lab can leave out' using errcode = 'BL966';
  end if;
  if p_on then
    insert into export_exclusions (lab_id, kind, value, created_by)
    values (p_lab_id, p_kind, btrim(p_value), auth.uid())
    on conflict (lab_id, kind, value) do nothing;
  else
    delete from export_exclusions where lab_id = p_lab_id and kind = p_kind and value = btrim(p_value);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('kind', x.kind, 'value', x.value) order by x.kind, x.value)
    from export_exclusions x where x.lab_id = p_lab_id
  ), '[]');
end
$$;

revoke all on function
  task_export_gaps(uuid), run_task_json(uuid), save_run_task(uuid, text, jsonb, uuid, text, boolean),
  task_export_source(uuid), build_task_export(uuid, uuid, bigint, text, jsonb),
  task_export_file(uuid, uuid), forget_task_export_files(uuid, uuid),
  set_export_exclusion(uuid, text, text, boolean)
from public, anon, authenticated;

grant execute on function
  run_task_json(uuid), save_run_task(uuid, text, jsonb, uuid, text, boolean),
  task_export_source(uuid), build_task_export(uuid, uuid, bigint, text, jsonb),
  task_export_file(uuid, uuid), forget_task_export_files(uuid, uuid),
  set_export_exclusion(uuid, text, text, boolean)
to authenticated;
