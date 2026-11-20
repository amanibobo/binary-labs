-- Planned versus actual, and which of a run's files were edited since (decisions.md, "the run
-- record: planned versus actual"). Functions only: the columns are 0034's. Errors: BL921 a
-- protocol version that isn't this lab's, BL922 an as-run text over 200,000 characters.

-- A run's files whose place in the lab's folder now holds other content: that place, the
-- version there that is the run's content, and the newest version. A file edited back to the
-- run's content isn't listed, nor is one gone from the lab's folder. The place is the one
-- run_json links to. Null for anyone outside the run's lab.
create function run_edited_files(p_run_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from runs where id = p_run_id and is_lab_member(lab_id)) then (
    select coalesce(jsonb_agg(jsonb_build_object(
        'sha256', f.sha256,
        'location_id', held.location_id,
        'held_version', held.number,
        'held_at', held.modified_at,
        'latest_version', latest.number,
        'latest_at', latest.modified_at
      ) order by f.position, f.sha256), '[]'::jsonb)
    from run_files f
    cross join lateral (
      select fv.location_id, fv.number, fv.modified_at
      from file_versions fv join file_locations fl on fl.id = fv.location_id
      where fv.lab_id = f.lab_id and fv.sha256 = f.sha256 and fl.deleted_at is null
      order by fv.seen_at desc, fv.id limit 1
    ) held
    cross join lateral (
      select fv.number, fv.modified_at from file_versions fv
      where fv.location_id = held.location_id order by fv.number desc limit 1
    ) latest
    where f.run_id = p_run_id
      and not exists (
        select 1 from file_locations fl
        where fl.lab_id = f.lab_id and fl.sha256 = f.sha256 and fl.deleted_at is null
      )
  ) end
$$;

-- The version of the experiment's protocol a run most likely followed: the newest saved on or
-- before the day it started (in UTC; today when it has no day), else the first. Null when the
-- experiment has no protocol. Checks nobody: only the functions below call it.
create function run_suggested_version(p_run_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select pv.id
  from runs r
  join experiments e on e.id = r.experiment_id and e.lab_id = r.lab_id
  join protocol_versions pv on pv.protocol_id = e.protocol_id and pv.lab_id = r.lab_id
  cross join lateral (select (pv.created_at at time zone 'UTC')::date <= coalesce(r.started_on, current_date) as before) d
  where r.id = p_run_id
  order by d.before desc, case when d.before then -pv.version else pv.version end
  limit 1
$$;

-- What a run's protocol can be: the suggested version, the one picked now, every version of the
-- experiment's protocol newest first, then the current version of each of the lab's other
-- protocols by title. p_query narrows to titles holding every word. Null outside the lab.
create function run_plan_choices(p_run_id uuid, p_query text default '', p_limit int default 12) returns jsonb
language sql stable security definer set search_path = public as $$
  with me as (
    select r.id, r.lab_id, r.planned_version_id, e.protocol_id, run_suggested_version(r.id) as suggested
    from runs r left join experiments e on e.id = r.experiment_id
    where r.id = p_run_id and is_lab_member(r.lab_id)
  ),
  words as (select w from regexp_split_to_table(lower(btrim(coalesce(p_query, ''))), '\s+') w where w <> ''),
  options as (
    select pv.id, pv.protocol_id, pv.title, pv.version, pv.created_at,
      p.current_version_id = pv.id as current,
      pv.id is not distinct from me.suggested as suggested,
      pv.id is not distinct from me.planned_version_id as picked,
      case
        when pv.id is not distinct from me.suggested then 0
        when pv.id is not distinct from me.planned_version_id then 1
        when pv.protocol_id is not distinct from me.protocol_id then 2
        else 3
      end as tier
    from me
    join protocol_versions pv on pv.lab_id = me.lab_id
    join protocols p on p.id = pv.protocol_id
    where (
        pv.id is not distinct from me.suggested
        or pv.id is not distinct from me.planned_version_id
        or pv.protocol_id is not distinct from me.protocol_id
        or (p.current_version_id = pv.id and p.archived_at is null and p.kind = 'protocol')
      )
      and not exists (select 1 from words where strpos(lower(pv.title), words.w) = 0)
  ),
  choices as (
    select * from options o
    order by o.tier, case when o.tier = 2 then -o.version end, lower(o.title), o.id
    limit least(greatest(coalesce(p_limit, 12), 1), 30)
  )
  select case when exists (select 1 from me) then coalesce((
    select jsonb_agg(jsonb_build_object(
        'version_id', c.id, 'protocol_id', c.protocol_id, 'title', c.title, 'version', c.version,
        'saved_at', c.created_at, 'current', c.current, 'suggested', c.suggested, 'picked', c.picked
      ) order by c.tier, case when c.tier = 2 then -c.version end, lower(c.title), c.id)
    from choices c
  ), '[]'::jsonb) end
$$;

-- The two texts the page compares: the protocol as written (the picked version's body), and
-- the version the as-run text started from, which the difference is drawn against. Null
-- outside the lab.
create function run_plan_bodies(p_run_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'planned', planned.body,
    'based_on', case when based.id is null then null else jsonb_build_object(
      'version_id', based.id, 'title', based.title, 'version', based.version, 'body', based.body
    ) end
  )
  from runs r
  left join protocol_versions planned on planned.id = r.planned_version_id
  left join protocol_versions based on based.id = r.as_run_based_on
  where r.id = p_run_id and is_lab_member(r.lab_id)
$$;

-- Picks the protocol version the run was planned from, or none (null). BL921: a version that
-- isn't this lab's.
create function set_run_plan(p_run_id uuid, p_version_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
begin
  if p_version_id is not null and not exists (select 1 from protocol_versions where id = p_version_id and lab_id = r.lab_id) then
    raise exception 'that protocol version isn''t in this lab' using errcode = 'BL921';
  end if;
  update runs set planned_version_id = p_version_id
  where id = r.id and planned_version_id is distinct from p_version_id;
  return run_json(r.id);
end
$$;

-- Saves what was actually done, with the version that text started from (p_based_on, or null
-- when it started from nothing) and who said so. An empty text clears it. Saving the same
-- text again changes nothing. BL921: a version that isn't this lab's. BL922: too long.
create function save_as_run(p_run_id uuid, p_body text, p_based_on uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
  v_body text := case when coalesce(p_body, '') ~ '^\s*$' then null else p_body end;
  v_based_on uuid := case when v_body is null then null else p_based_on end;
begin
  if length(v_body) > 200000 then
    raise exception 'the as-run text is too long' using errcode = 'BL922';
  end if;
  if v_based_on is not null and not exists (select 1 from protocol_versions where id = v_based_on and lab_id = r.lab_id) then
    raise exception 'that protocol version isn''t in this lab' using errcode = 'BL921';
  end if;
  update runs set
    as_run_body = v_body,
    as_run_based_on = v_based_on,
    as_run_by = case when v_body is null then null else auth.uid() end,
    as_run_at = case when v_body is null then null else now() end
  where id = r.id and (as_run_body, as_run_based_on) is distinct from (v_body, v_based_on);
  return run_json(r.id);
end
$$;

revoke all on function
  run_edited_files(uuid), run_suggested_version(uuid), run_plan_choices(uuid, text, int),
  run_plan_bodies(uuid), set_run_plan(uuid, uuid), save_as_run(uuid, text, uuid)
from public, anon, authenticated;
grant execute on function
  run_edited_files(uuid), run_plan_choices(uuid, text, int), run_plan_bodies(uuid),
  set_run_plan(uuid, uuid), save_as_run(uuid, text, uuid)
to authenticated;
