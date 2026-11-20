-- Sharing and the export gate (decisions.md, "the run record: sharing and the gate"). The two
-- switches, the gate that answers "may this run leave the lab?", and the log people read.
-- Functions only: every table, column and trigger is in 0034, and its triggers already log
-- each switch, turn a changed run's sharing off and withdraw built folders. Nothing here
-- exports anything.

-- Why a run can't leave the lab right now, for the gate and the run page. The consent rule
-- itself is run_export_blocks (0034); this adds the one the gate alone asks: a confirmed cause
-- must have been attested by the named confirmer's own account. Null when there is no such run.
create function run_share_blocks(p_run_id uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select run_export_blocks(r.id)
    || case when r.confirmed_cause is not null and r.confirmer_attested_at is null then array['not_attested'] else '{}' end
  from runs r where r.id = p_run_id
$$;

-- A run's switch belongs to the person who ran it (their own account) or an admin of its lab.
create function can_share_run(p_lab_id uuid, p_person_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_lab_admin(p_lab_id) or exists (
    select 1 from people p
    where p.id = p_person_id and p.lab_id = p_lab_id and p.member_user_id = auth.uid()
  )
$$;

-- The lab's side of sharing, for any member of it; null for anyone else. `built` counts the
-- folders made from the lab's runs that still stand.
create function lab_sharing(p_lab_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'agreed_at', l.sharing_agreed_at,
    'agreement', l.sharing_agreement,
    'agreed_by', (
      select coalesce(
        (select p.display_name from people p where p.lab_id = l.id and p.member_user_id = l.sharing_agreed_by limit 1),
        (select u.email::text from auth.users u where u.id = l.sharing_agreed_by)
      )
    ),
    'can_change', is_lab_admin(l.id),
    'demo', l.plan = 'demo',
    'built', (select count(*) from task_exports t where t.lab_id = l.id and t.withdrawn_at is null)
  )
  from labs l where l.id = p_lab_id and is_lab_member(l.id)
$$;

-- One run's side of sharing, for a member of its lab; null for anyone else. `blocks` is what
-- still stops it leaving (empty: it can); `built` and `withdrawn` count its folders.
create function run_sharing(p_run_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'share', r.share,
    'can_change', can_share_run(r.lab_id, r.person_id),
    'blocks', to_jsonb(run_share_blocks(r.id)),
    'built', (select count(*) from task_exports t where t.run_id = r.id and t.withdrawn_at is null),
    'withdrawn', (select count(*) from task_exports t where t.run_id = r.id and t.withdrawn_at is not null)
  )
  from runs r where r.id = p_run_id and is_lab_member(r.lab_id)
$$;

-- Turns a run's sharing on or off. The 0034 triggers log it and withdraw its built folders
-- when it goes off; when there were folders, this adds the line that copies already sent
-- can't be pulled back. BL931: not the person who ran it or an admin. BL932: a demo lab.
create function set_run_share(p_run_id uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
  v_on boolean := coalesce(p_on, false);
  v_built int;
begin
  if not can_share_run(r.lab_id, r.person_id) then
    raise exception 'only the person who ran it or an admin shares a run' using errcode = 'BL931';
  end if;
  if v_on and exists (select 1 from labs where id = r.lab_id and plan = 'demo') then
    raise exception 'a demo lab''s runs are never shared' using errcode = 'BL932';
  end if;
  select count(*) into v_built from task_exports where run_id = r.id and withdrawn_at is null;
  update runs set share = v_on where id = r.id and share <> v_on;
  if not v_on and v_built > 0 then
    insert into run_log (lab_id, run_id, actor, via, action, after)
    values (r.lab_id, r.id, auth.uid(), 'person', 'export.blocked',
      jsonb_build_object('blocks', array['withdrawn'], 'folders', v_built, 'sent_copies', 'cannot be pulled back'));
  end if;
  return run_json(r.id);
end
$$;

-- An admin agrees to the lab's sharing agreement (p_agreement is the version of the wording
-- they were shown), or takes the agreement back. Agreeing again to the same wording changes
-- nothing. The 0034 trigger logs it and withdraws every folder when it goes off. 42501: not an
-- admin of this lab. BL932: a demo lab. BL933: no version of the wording.
create function set_lab_share(p_lab_id uuid, p_on boolean, p_agreement text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  l labs;
  v_agreement text := nullif(btrim(coalesce(p_agreement, '')), '');
  v_built int;
begin
  if auth.uid() is null or not is_lab_admin(p_lab_id) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  select * into l from labs where id = p_lab_id for update;
  if coalesce(p_on, false) then
    if l.plan = 'demo' then
      raise exception 'a demo lab''s runs are never shared' using errcode = 'BL932';
    end if;
    if v_agreement is null or length(v_agreement) > 100 then
      raise exception 'say which wording was agreed to' using errcode = 'BL933';
    end if;
    update labs set sharing_agreed_at = now(), sharing_agreed_by = auth.uid(), sharing_agreement = v_agreement
    where id = l.id and sharing_agreement is distinct from v_agreement;
  else
    select count(*) into v_built from task_exports where lab_id = l.id and withdrawn_at is null;
    update labs set sharing_agreed_at = null, sharing_agreed_by = null, sharing_agreement = null
    where id = l.id and sharing_agreed_at is not null;
    if v_built > 0 then
      insert into run_log (lab_id, actor, via, action, after)
      values (l.id, auth.uid(), 'person', 'export.blocked',
        jsonb_build_object('blocks', array['withdrawn'], 'folders', v_built, 'sent_copies', 'cannot be pulled back'));
    end if;
  end if;
  return lab_sharing(l.id);
end
$$;

-- "May this run leave the lab?" The only way to get a grant. It answers and never raises:
-- { allowed, blocks, grant_id, expires_at }. Every ask is logged: allowed (that row is the
-- grant: one folder, within the hour, checked again by the 0034 trigger when the folder is
-- built) or blocked, with why. A caller who isn't a member of the run's lab is told there is
-- no such run, and the lab's log keeps the attempt.
create function export_gate(p_run_id uuid, p_purpose text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs;
  v_lab uuid;
  v_blocks text[];
  v_purpose text := nullif(left(btrim(coalesce(p_purpose, '')), 200), '');
  v_grant bigint;
begin
  begin
    r := member_run(p_run_id);
  exception
    when sqlstate 'BL907' or insufficient_privilege then
      select lab_id into v_lab from runs where id = p_run_id;
      if v_lab is not null then
        insert into run_log (lab_id, run_id, actor, via, action, after)
        values (v_lab, p_run_id, auth.uid(), run_via(), 'export.blocked',
          jsonb_build_object('blocks', array['not_member'], 'purpose', v_purpose));
      end if;
      return jsonb_build_object('allowed', false, 'blocks', array['no_such_run'], 'grant_id', null, 'expires_at', null);
  end;
  v_blocks := run_share_blocks(r.id);
  if cardinality(v_blocks) > 0 then
    insert into run_log (lab_id, run_id, actor, via, action, after)
    values (r.lab_id, r.id, auth.uid(), 'person', 'export.blocked', jsonb_build_object('blocks', v_blocks, 'purpose', v_purpose));
    return jsonb_build_object('allowed', false, 'blocks', v_blocks, 'grant_id', null, 'expires_at', null);
  end if;
  insert into run_log (lab_id, run_id, actor, via, action, after)
  values (r.lab_id, r.id, auth.uid(), 'person', 'export.allowed',
    jsonb_build_object('purpose', v_purpose, 'expires_at', now() + interval '1 hour'))
  returning id into v_grant;
  return jsonb_build_object('allowed', true, 'blocks', '[]'::jsonb, 'grant_id', v_grant, 'expires_at', now() + interval '1 hour');
end
$$;

-- The sharing log, newest first: both switches and every export attempt. With a run, that
-- run's rows for any member of the lab; without one, the whole lab's for an admin. 42501
-- otherwise. `actor_name` is null for someone who isn't in the lab.
create function sharing_log(p_lab_id uuid, p_run_id uuid default null, p_limit int default 100) returns setof jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null
    or not (case when p_run_id is null then is_lab_admin(p_lab_id) else is_lab_member(p_lab_id) end) then
    raise exception 'not yours to read' using errcode = '42501';
  end if;
  return query
  select jsonb_build_object(
    'id', l.id,
    'run_id', l.run_id,
    'run_title', r.title,
    'action', l.action,
    'via', l.via,
    'actor', l.actor,
    'actor_name', coalesce(
      (select p.display_name from people p where p.lab_id = l.lab_id and p.member_user_id = l.actor limit 1),
      (select u.email::text from auth.users u join members m on m.user_id = u.id where m.lab_id = l.lab_id and u.id = l.actor)
    ),
    'before', l.before,
    'after', l.after,
    'at', l.at
  )
  from run_log l left join runs r on r.id = l.run_id
  where l.lab_id = p_lab_id
    and l.action in ('run.share', 'lab.share', 'export.allowed', 'export.blocked')
    and (p_run_id is null or l.run_id = p_run_id)
  order by l.id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
end
$$;

revoke all on function
  run_share_blocks(uuid), can_share_run(uuid, uuid), lab_sharing(uuid), run_sharing(uuid),
  set_run_share(uuid, boolean), set_lab_share(uuid, boolean, text), export_gate(uuid, text),
  sharing_log(uuid, uuid, int)
from public, anon, authenticated;

grant execute on function
  lab_sharing(uuid), run_sharing(uuid), set_run_share(uuid, boolean), set_lab_share(uuid, boolean, text),
  export_gate(uuid, text), sharing_log(uuid, uuid, int)
to authenticated;
