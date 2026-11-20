-- The model check (decisions.md, "the run record: the model check"). A lab member asks a few
-- frontier models to answer a built task folder; the worker sends each model the de-identified
-- task (never the answer key or the rubric), a grader model judges each answer against the
-- confirmed cause, and a second scientist judges what the grader calls partial or unclear.
-- Their judgment wins. The lab keeps the tasks most models fail.
--
-- 0034's model-check table had room for an answer and whether it solved the task; this adds
-- the columns the grader's reason, the cost cap and the second scientist's judgment need, a
-- column on the folder for keeping it, and the worker's published setup. Nothing here sends
-- anything: the worker does, and 0034's trigger and assert_exportable still have the last word.
--
-- Errors: BL971 no such task, BL972 the model check has no keys or no models, BL973 a check of
-- this task is still running, BL974 that answer can't be judged (it isn't answered), BL975 the
-- person who ran the run can't judge its answers, BL976 the folder was withdrawn.

-- One press of "Check with models" makes one row per model, all with the same check_id, so the
-- insert trigger rechecks consent at the moment someone asks, and the worker again before every
-- call. A row's state: waiting (not sent yet), answered, failed (the model couldn't be reached
-- or gave no answer), refused (sharing went off first) or skipped (over the cost cap, or the
-- task is too long to send).
alter table task_model_runs
  add column check_id uuid,
  add column state text not null default 'waiting'
    check (state in ('waiting', 'answered', 'failed', 'refused', 'skipped')),
  add column requested_by uuid references auth.users (id) on delete set null,
  add column cost_cap_usd numeric(8, 2) check (cost_cap_usd > 0),
  add column cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  add column error text check (error is null or length(error) <= 500),
  -- The grader's verdict on the answer, and why, in its words.
  add column verdict text check (verdict in ('solved', 'partial', 'not_solved', 'unclear')),
  add column reason text check (reason is null or length(reason) <= 2000),
  add column grader text,
  -- The second scientist's judgment against the rubric. It sets solved.
  add column judged_by uuid references auth.users (id) on delete set null,
  add column judged_note text check (judged_note is null or length(judged_note) <= 2000),
  add column judged_at timestamptz,
  add constraint task_model_runs_check_model_key unique (check_id, model),
  add constraint task_model_runs_answer_state check ((state = 'answered') = (answer is not null)),
  add constraint task_model_runs_verdict_state check (verdict is null or state = 'answered'),
  add constraint task_model_runs_judged_state check (
    (judged_at is null) = (judged_by is null) and (judged_at is null or (state = 'answered' and solved is not null))
  ),
  -- Until a scientist judges it, whether an answer solved the task is the grader's verdict and
  -- nothing else: solved or not solved, and empty for partial or unclear.
  add constraint task_model_runs_solved_by check (
    judged_at is not null
    or solved is not distinct from case verdict when 'solved' then true when 'not_solved' then false end
  );
create index task_model_runs_check_idx on task_model_runs (check_id) where check_id is not null;

-- "Keep this task": the lab keeps a task most models failed.
alter table task_exports add column kept_at timestamptz;
alter table task_exports add column kept_by uuid references auth.users (id) on delete set null;

-- What the worker can run, as it last said: written by the worker from its own environment,
-- so the page tells the truth about the worker's keys and the web app holds none of them.
-- models: [{model, ceiling_usd}] for the models it can reach, unreachable: [{model, needs}],
-- missing: the keys to add when it can reach no model or no grader.
create table model_check_setup (
  id boolean primary key default true check (id),
  models jsonb not null default '[]' check (jsonb_typeof(models) = 'array'),
  unreachable jsonb not null default '[]' check (jsonb_typeof(unreachable) = 'array'),
  grader text,
  cost_cap_usd numeric(8, 2) not null check (cost_cap_usd > 0),
  missing text[] not null default '{}',
  updated_at timestamptz not null default now()
);
alter table model_check_setup enable row level security;
create policy model_check_setup_select on model_check_setup for select using (auth.uid() is not null);

-- The setup as the page reads it, and whether the check can run at all.
create function model_check_setup_json() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'models', s.models,
    'unreachable', s.unreachable,
    'grader', s.grader,
    'cost_cap_usd', s.cost_cap_usd,
    'ceiling_usd', coalesce((select sum((m ->> 'ceiling_usd')::numeric) from jsonb_array_elements(s.models) m), 0),
    'missing', to_jsonb(s.missing),
    'ready', jsonb_array_length(s.models) > 0 and s.grader is not null
  )
  from model_check_setup s
$$;

-- A built folder of the caller's lab, with its run locked. BL971: no such task, or another
-- lab's (which reads the same, so a task id says nothing about other labs).
create function member_task(p_task_id uuid) returns task_exports
language plpgsql security definer set search_path = public as $$
declare
  t task_exports;
begin
  select * into t from task_exports where id = p_task_id;
  if not found or not is_lab_member(t.lab_id) then
    raise exception 'no such task' using errcode = 'BL971';
  end if;
  perform member_run(t.run_id);
  return t;
end
$$;

-- Asks the worker to check a task with every model it can reach. BL972 without keys, BL973
-- while an earlier check of the task still has a model waiting, and BL951 from 0034's insert
-- trigger unless the folder stands and its run can still be shared.
create function request_model_check(p_task_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t task_exports;
  s model_check_setup;
  v_check uuid := gen_random_uuid();
begin
  t := member_task(p_task_id);
  select * into s from model_check_setup;
  if not found or jsonb_array_length(s.models) = 0 or s.grader is null then
    raise exception 'the model check has no keys' using errcode = 'BL972';
  end if;
  if exists (select 1 from task_model_runs where task_id = t.id and state = 'waiting') then
    raise exception 'a check of this task is still running' using errcode = 'BL973';
  end if;
  insert into task_model_runs (task_id, lab_id, model, check_id, requested_by, cost_cap_usd)
  select t.id, t.lab_id, m ->> 'model', v_check, auth.uid(), s.cost_cap_usd
  from jsonb_array_elements(s.models) m;
  return v_check;
end
$$;

-- The second scientist's judgment of one answer, against the rubric. It decides whether the
-- answer solved the task, whatever the grader said. Null takes the judgment back. BL974: the
-- answer isn't there to judge. BL975: the caller ran this run.
create function judge_model_answer(p_answer_id uuid, p_solved boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare
  a task_model_runs;
  t task_exports;
  r runs;
begin
  select * into a from task_model_runs where id = p_answer_id;
  if not found then
    raise exception 'no such answer' using errcode = 'BL971';
  end if;
  t := member_task(a.task_id);
  select * into r from runs where id = t.run_id;
  if a.state <> 'answered' then
    raise exception 'that answer can''t be judged' using errcode = 'BL974';
  end if;
  if exists (select 1 from people p where p.id = r.person_id and p.member_user_id = auth.uid()) then
    raise exception 'the person who ran it can''t judge its answers' using errcode = 'BL975';
  end if;
  update task_model_runs set
    solved = case when p_solved is null then case verdict when 'solved' then true when 'not_solved' then false end else p_solved end,
    judged_by = case when p_solved is null then null else auth.uid() end,
    judged_at = case when p_solved is null then null else now() end,
    judged_note = case when p_solved is null then null else nullif(btrim(coalesce(p_note, '')), '') end
  where id = a.id;
end
$$;

-- Keeps a task for the lab, or stops keeping it. BL976: the folder was withdrawn.
create function keep_model_task(p_task_id uuid, p_keep boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  t task_exports;
begin
  t := member_task(p_task_id);
  if p_keep and t.withdrawn_at is not null then
    raise exception 'this folder was withdrawn' using errcode = 'BL976';
  end if;
  update task_exports set
    kept_at = case when p_keep then coalesce(kept_at, now()) end,
    kept_by = case when p_keep then coalesce(kept_by, auth.uid()) end
  where id = t.id;
end
$$;

-- A lab member's name, for "judged by". Null when they have no person in the lab.
create function member_name(p_lab_id uuid, p_user_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select p.display_name from people p where p.lab_id = p_lab_id and p.member_user_id = p_user_id
  order by p.created_at limit 1
$$;

-- The model check as the run's page shows it: the setup, what the second scientist judges
-- against, and each folder built from the run (newest first) with its latest check. Null for
-- another lab's run.
create function run_model_checks_json(p_run_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'run_id', r.id,
    'title', r.title,
    'setup', model_check_setup_json(),
    'confirmed_cause', r.confirmed_cause,
    'question', q.question,
    'rubric', coalesce(q.rubric, '[]'),
    'can_judge', not exists (select 1 from people p where p.id = r.person_id and p.member_user_id = auth.uid()),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'task_id', t.id,
        'built_at', t.built_at,
        'withdrawn_at', t.withdrawn_at,
        'kept_at', t.kept_at,
        'kept_by', member_name(t.lab_id, t.kept_by),
        'check', (
          select jsonb_build_object(
            'id', c.check_id,
            'requested_at', min(m.started_at),
            'cost_cap_usd', max(m.cost_cap_usd),
            'spent_usd', sum(m.cost_usd),
            'answers', jsonb_agg(jsonb_build_object(
              'id', m.id, 'model', m.model, 'state', m.state, 'answer', m.answer, 'verdict', m.verdict,
              'reason', m.reason, 'solved', m.solved, 'error', m.error, 'cost_usd', m.cost_usd,
              'judged_by', member_name(m.lab_id, m.judged_by), 'judged_note', m.judged_note, 'judged_at', m.judged_at
            ) order by m.model)
          )
          from task_model_runs m
          join (
            select x.check_id from task_model_runs x
            where x.task_id = t.id and x.check_id is not null
            group by x.check_id order by min(x.started_at) desc limit 1
          ) c on c.check_id = m.check_id
          group by c.check_id
        )
      ) order by t.built_at desc, t.id)
      from task_exports t where t.run_id = r.id
    ), '[]')
  )
  from runs r
  left join run_rubrics q on q.run_id = r.id
  where r.id = p_run_id and is_lab_member(r.lab_id)
$$;

revoke all on model_check_setup from anon, authenticated;
revoke all on function
  model_check_setup_json(), member_task(uuid), request_model_check(uuid),
  judge_model_answer(uuid, boolean, text), keep_model_task(uuid, boolean), member_name(uuid, uuid),
  run_model_checks_json(uuid)
from public, anon, authenticated;

grant select on model_check_setup to authenticated;
grant execute on function
  model_check_setup_json(), request_model_check(uuid), judge_model_answer(uuid, boolean, text),
  keep_model_task(uuid, boolean), run_model_checks_json(uuid)
to authenticated;
