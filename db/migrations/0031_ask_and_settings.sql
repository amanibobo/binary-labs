-- Ask the lab and Settings, round 2: label suggestions edited before approval, protocol edit
-- suggestions drawn from the protocol's talk-throughs and flags, an admin control for the
-- monthly AI cap, and removing a member or changing their role.

alter type audit_action add value if not exists 'member.remove';
alter type audit_action add value if not exists 'member.role';
alter type audit_action add value if not exists 'lab.ai_cap';

-- Approving label changes, now with the member's own values for any chosen file. An edit is
-- {sha256, clean_name, date, experiment_id, person_id} and replaces that file's proposal; as in
-- a proposal, a null field leaves the label's value as it is. Edits name only chosen files
-- (BL602). An edited or partial approval is marked edited.
drop function approve_label_suggestion(uuid, text[]);
create function approve_label_suggestion(p_id uuid, p_shas text[], p_edits jsonb default '[]')
returns table (sha256 text, correction_id bigint)
language plpgsql security invoker set search_path = public as $$
declare
  s suggestions;
  item suggestion_labels;
  cur record;
  edit jsonb;
  v_name text;
  v_date date;
  v_experiment uuid;
  v_person uuid;
  v_correction bigint;
  v_edited boolean := false;
  done jsonb := '[]';
begin
  select * into s from suggestions where id = p_id and kind = 'labels' and state = 'open';
  if not found then
    raise exception 'this suggestion was already decided' using errcode = 'BL601';
  end if;
  if coalesce(cardinality(p_shas), 0) = 0 or exists (
    select 1 from unnest(p_shas) x
    where not exists (select 1 from suggestion_labels sl where sl.suggestion_id = p_id and sl.sha256 = x)
  ) then
    raise exception 'pick files from this suggestion' using errcode = 'BL602';
  end if;
  if jsonb_typeof(coalesce(p_edits, '[]')) <> 'array' or exists (
    select 1 from jsonb_array_elements(coalesce(p_edits, '[]')) e
    where jsonb_typeof(e.value) <> 'object' or (e.value ->> 'sha256') is null or not (e.value ->> 'sha256' = any (p_shas))
  ) then
    raise exception 'edits name chosen files only' using errcode = 'BL602';
  end if;
  for item in select * from suggestion_labels sl where sl.suggestion_id = p_id and sl.sha256 = any (p_shas) order by sl.sha256 loop
    edit := null;
    select e.value into edit from jsonb_array_elements(coalesce(p_edits, '[]')) e where e.value ->> 'sha256' = item.sha256 limit 1;
    if edit is null then
      v_name := item.clean_name;
      v_date := item.date;
      v_experiment := item.experiment_id;
      v_person := item.person_id;
    else
      v_name := nullif(btrim(edit ->> 'clean_name'), '');
      v_date := (edit ->> 'date')::date;
      v_experiment := (edit ->> 'experiment_id')::uuid;
      v_person := (edit ->> 'person_id')::uuid;
      v_edited := v_edited
        or v_name is distinct from item.clean_name or v_date is distinct from item.date
        or v_experiment is distinct from item.experiment_id or v_person is distinct from item.person_id;
    end if;
    -- Members read labels by column, so name the ones this needs.
    select l.clean_name, l.date, l.experiment_id, l.person_id, l.instrument, l.tags into cur
    from labels l where l.lab_id = s.lab_id and l.sha256 = item.sha256;
    select c.correction_id into v_correction
    from correct_label(s.lab_id, item.sha256,
      coalesce(v_name, cur.clean_name), coalesce(v_date, cur.date),
      coalesce(v_experiment, cur.experiment_id), coalesce(v_person, cur.person_id),
      cur.instrument, cur.tags) c;
    done := done || jsonb_build_object('sha256', item.sha256, 'correction_id', v_correction);
    sha256 := item.sha256;
    correction_id := v_correction;
    return next;
  end loop;
  perform settle_suggestion(p_id, null, v_edited or cardinality(p_shas) <
    (select count(*) from suggestion_labels sl where sl.suggestion_id = p_id), done);
end
$$;

-- What a protocol's own record says about how it goes: the transcripts of its talk-throughs
-- and the flags its checks raised, each on the file it belongs to, newest first. A protocol
-- edit suggestion reads these beside the files a search finds.
create function protocol_evidence(p_protocol_id uuid, p_limit int default 4)
returns table (
  kind text,
  sha256 text,
  file_kind file_kind,
  locations jsonb,
  label jsonb,
  at timestamptz,
  transcript text,
  flag jsonb
)
language sql stable security definer set search_path = public as $$
  with p as (
    select pr.id, pr.lab_id from protocols pr where pr.id = p_protocol_id and is_lab_member(pr.lab_id)
  ),
  talks as (
    select 'talk_through'::text as kind, said.sha256, t.recorded_at as at, left(tr.content, 6000) as transcript, null::jsonb as flag
    from p
    join talk_throughs t on t.lab_id = p.lab_id
    left join protocol_versions uv on uv.id = t.used_version_id
    join lateral (
      select coalesce(t.video_sha256, fl.sha256) as sha256
      from file_locations fl where fl.id = t.location_id
    ) said on said.sha256 is not null
    join lateral (
      select e.content from extractions e
      where e.sha256 = said.sha256 and e.kind::text = 'transcript' and btrim(e.content) <> ''
      order by e.created_at desc limit 1
    ) tr on true
    where (t.protocol_id = p.id or uv.protocol_id = p.id) and t.dismissed_at is null
    order by t.recorded_at desc
    limit least(p_limit, 8)
  ),
  raised as (
    select 'flag'::text as kind, f.sha256, f.raised_at as at, null::text as transcript,
      jsonb_build_object(
        'check', coalesce((
          select c ->> 'name' from protocol_versions v, jsonb_array_elements(v.expected_values) c
          where v.id = f.protocol_version_id and c ->> 'id' = f.check_id::text
        ), 'A check'),
        'kind', f.kind,
        'observed', f.observed,
        'expected', f.expected,
        'unit', f.unit,
        'review', f.review,
        'note', f.review_note
      ) as flag
    from p join flags f on f.protocol_id = p.id and f.lab_id = p.lab_id
    where f.cleared_at is null
    order by f.raised_at desc
    limit least(p_limit, 8)
  ),
  both_kinds as (select * from talks union all select * from raised)
  select b.kind, b.sha256, bl.file_kind, live_locations_json(p.lab_id, b.sha256), label_json(p.lab_id, b.sha256),
    b.at, b.transcript, b.flag
  from both_kinds b
  cross join p
  join blobs bl on bl.sha256 = b.sha256
  where live_locations_json(p.lab_id, b.sha256) is not null
  order by b.kind, b.at desc
$$;

-- The monthly cap on questions and suggestions together, in US dollars. Admins only.
create function set_ai_cap(p_lab_id uuid, p_cap_usd numeric) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_cap numeric;
begin
  if not is_lab_admin(p_lab_id) then
    raise exception 'only admins change the cap' using errcode = '42501';
  end if;
  if p_cap_usd is null or p_cap_usd < 0 or p_cap_usd > 1000 then
    raise exception 'the cap is between 0 and 1000' using errcode = '22023';
  end if;
  update labs set ai_monthly_cap_usd = round(p_cap_usd, 2) where id = p_lab_id
  returning ai_monthly_cap_usd into v_cap;
  insert into audit_log (lab_id, actor, action, target) values (p_lab_id, auth.uid(), 'lab.ai_cap', v_cap::text);
  return v_cap;
end
$$;

-- Removing a member and changing a role. Admins only, and a lab always keeps an admin: the
-- last one can't remove or demote themselves (BL811). The lab's admins are locked first, so
-- two admins demoting each other at once can't leave it with none. Removing someone deletes
-- only their membership: what they made stays, and its author stays their user id.
create function remove_member(p_lab_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role member_role;
begin
  if not is_lab_admin(p_lab_id) then
    raise exception 'only admins remove members' using errcode = '42501';
  end if;
  perform 1 from members where lab_id = p_lab_id and role = 'admin' for update;
  select role into v_role from members where lab_id = p_lab_id and user_id = p_user_id for update;
  if not found then
    raise exception 'not a member of this lab' using errcode = 'BL812';
  end if;
  if v_role = 'admin' and (select count(*) from members where lab_id = p_lab_id and role = 'admin') = 1 then
    raise exception 'a lab keeps at least one admin' using errcode = 'BL811';
  end if;
  delete from members where lab_id = p_lab_id and user_id = p_user_id;
  insert into audit_log (lab_id, actor, action, target) values (p_lab_id, auth.uid(), 'member.remove', p_user_id::text);
end
$$;

create function set_member_role(p_lab_id uuid, p_user_id uuid, p_role member_role) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role member_role;
begin
  if not is_lab_admin(p_lab_id) then
    raise exception 'only admins change roles' using errcode = '42501';
  end if;
  perform 1 from members where lab_id = p_lab_id and role = 'admin' for update;
  select role into v_role from members where lab_id = p_lab_id and user_id = p_user_id for update;
  if not found then
    raise exception 'not a member of this lab' using errcode = 'BL812';
  end if;
  if v_role = p_role then
    return;
  end if;
  if v_role = 'admin' and (select count(*) from members where lab_id = p_lab_id and role = 'admin') = 1 then
    raise exception 'a lab keeps at least one admin' using errcode = 'BL811';
  end if;
  update members set role = p_role where lab_id = p_lab_id and user_id = p_user_id;
  insert into audit_log (lab_id, actor, action, target) values (p_lab_id, auth.uid(), 'member.role', p_user_id::text || ':' || p_role::text);
end
$$;

-- Removing goes through remove_member, so it's audited and the last admin stays.
drop policy members_delete on members;
revoke delete on members from authenticated;

alter function protocol_evidence(uuid, int) set client_min_messages = warning;

revoke all on function
  approve_label_suggestion(uuid, text[], jsonb), protocol_evidence(uuid, int), set_ai_cap(uuid, numeric),
  remove_member(uuid, uuid), set_member_role(uuid, uuid, member_role)
from public, anon, authenticated;
grant execute on function
  approve_label_suggestion(uuid, text[], jsonb), protocol_evidence(uuid, int), set_ai_cap(uuid, numeric),
  remove_member(uuid, uuid), set_member_role(uuid, uuid, member_role)
to authenticated;
