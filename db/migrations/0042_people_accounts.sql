-- Linking a lab's People to Binary accounts (decisions.md, "People linked to accounts"). A
-- People row is who a label, a run or a confirmed cause names; people.member_user_id says which
-- member's account is that person. Until now only a member's first upload or talk-through set
-- it (0008, 0009), so a confirmer whose row was never linked couldn't say yes (attest_cause,
-- 0035), and since 0041 none of their runs could be exported. Here a row is linked when its
-- member joins with a matching name, by the member themselves ("This is me"), or by an admin.
-- Each link and unlink is in the audit log.
--
-- A yes belongs to the account that gave it. Any change to a row's link away from an account
-- (an admin's unlink, or the member leaving the lab) takes back the yeses on causes that row
-- confirmed, so a yes can never pass to whoever is linked next.
--
-- Also: leaving failed or odd now asks before it removes a failure type picked without a cause
-- (set_run_status, redefined with the same signature).
--
-- Errors: BL981 no such person. BL982 the person is already linked to another account. BL983
-- the member is already linked to another person in this lab. BL984 not a member of this lab.

-- A new enum value can't be used in the transaction that adds it, so no parsed SQL below names
-- these; plpgsql bodies are only checked when they run.
alter type audit_action add value if not exists 'person.link';
alter type audit_action add value if not exists 'person.unlink';

-- A name as it is compared when someone joins: case, spaces and punctuation aside, so the
-- address priya.nair@lab.edu finds Priya Nair.
create function person_name_key(p_name text) returns text
language sql immutable parallel safe as $$
  select lower(regexp_replace(coalesce(p_name, ''), '[^[:alnum:]]+', '', 'g'))
$$;

-- Links a person and writes the audit row. Callers have checked who may and locked both rows.
create function put_person_link(p_person_id uuid, p_lab_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update people set member_user_id = p_user_id where id = p_person_id and lab_id = p_lab_id;
  insert into audit_log (lab_id, actor, action, target)
  values (p_lab_id, auth.uid(), 'person.link', p_person_id::text || ':' || p_user_id::text);
end
$$;

-- Someone joining a lab is linked to the one People row with their name, if there is exactly
-- one and nobody has it. Two rows with that name, or one already linked, link nothing: "This
-- is me" or an admin settles it.
create function members_link_person() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_key text := person_name_key(member_display_name(new.user_id));
  v_rows uuid[];
begin
  if v_key = '' then
    return null;
  end if;
  select array_agg(p.id order by p.id) into v_rows from people p
  where p.lab_id = new.lab_id and person_name_key(p.display_name) = v_key;
  if cardinality(v_rows) is distinct from 1
    or exists (select 1 from people p where p.id = v_rows[1] and p.member_user_id is not null) then
    return null;
  end if;
  perform put_person_link(v_rows[1], new.lab_id, new.user_id);
  return null;
end
$$;
create trigger members_link_person after insert on members
for each row execute function members_link_person();

-- A row's link moving away from an account takes back the yeses that account gave as this
-- person. The run log marks it as the trigger's doing, and a shared run stops being shared.
create function people_link_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_via text := current_setting('binary.run_via', true);
begin
  perform set_config('binary.run_via', 'trigger', true);
  update runs set confirmer_attested_at = null
  where lab_id = new.lab_id and confirmed_by = new.id and confirmer_attested_at is not null;
  perform set_config('binary.run_via', coalesce(v_via, ''), true);
  return null;
end
$$;
create trigger people_link_changed after update of member_user_id on people
for each row when (old.member_user_id is not null and old.member_user_id is distinct from new.member_user_id)
execute function people_link_changed();

-- A yes given before this migration on a row that has since lost its account (its member left)
-- is taken back the same way.
select set_config('binary.run_via', 'migration', true);
update runs r set confirmer_attested_at = null
from people p
where p.id = r.confirmed_by and p.lab_id = r.lab_id and p.member_user_id is null and r.confirmer_attested_at is not null;
select set_config('binary.run_via', '', true);

-- The person, locked. BL981 when there's no such row; 42501 when it isn't the caller's lab.
create function member_person(p_person_id uuid) returns people
language plpgsql security definer set search_path = public as $$
declare
  p people;
begin
  select * into p from people where id = p_person_id for update;
  if not found then
    raise exception 'no such person' using errcode = 'BL981';
  end if;
  if not is_lab_member(p.lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  return p;
end
$$;

-- Links p_user_id to the person unless either is linked elsewhere. The member's row is locked
-- so two links for one member at once can't both pass. Saying it again is a no-op.
create function link_checked(p people, p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from members m where m.lab_id = p.lab_id and m.user_id = p_user_id for update;
  if not found then
    raise exception 'not a member of this lab' using errcode = 'BL984';
  end if;
  if p.member_user_id is not distinct from p_user_id then
    return;
  end if;
  if p.member_user_id is not null then
    raise exception 'this person is linked to another account' using errcode = 'BL982';
  end if;
  if exists (select 1 from people o where o.lab_id = p.lab_id and o.member_user_id = p_user_id and o.id <> p.id) then
    raise exception 'that account is linked to another person in this lab' using errcode = 'BL983';
  end if;
  perform put_person_link(p.id, p.lab_id, p_user_id);
end
$$;

-- "This is me": the caller links themselves to a person nobody has, if they aren't already
-- someone else in this lab.
create function claim_person(p_person_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p people := member_person(p_person_id);
begin
  perform link_checked(p, auth.uid());
end
$$;

-- An admin links a person to one of the lab's members.
create function link_person(p_person_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p people := member_person(p_person_id);
begin
  if not is_lab_admin(p.lab_id) then
    raise exception 'only admins link other people' using errcode = '42501';
  end if;
  perform link_checked(p, p_user_id);
end
$$;

-- An admin unlinks a person from their account. Returns how many yeses that took back (the
-- trigger does it); an unlinked person is left as it is and returns 0.
create function unlink_person(p_person_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  p people := member_person(p_person_id);
  v_yeses int;
begin
  if not is_lab_admin(p.lab_id) then
    raise exception 'only admins unlink people' using errcode = '42501';
  end if;
  if p.member_user_id is null then
    return 0;
  end if;
  select count(*) into v_yeses from runs r
  where r.lab_id = p.lab_id and r.confirmed_by = p.id and r.confirmer_attested_at is not null;
  update people set member_user_id = null where id = p.id;
  insert into audit_log (lab_id, actor, action, target)
  values (p.lab_id, auth.uid(), 'person.unlink', p.id::text || ':' || p.member_user_id::text);
  return v_yeses;
end
$$;

-- The lab's People with who each is linked to: the account's email, `you` for the caller's own
-- row, and `yeses`, the confirmed causes this person has said yes to (what unlinking would take
-- back). Empty for anyone outside the lab.
create function lab_people(p_lab_id uuid) returns setof jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id,
    'name', p.display_name,
    'aliases', to_jsonb(p.aliases),
    'user_id', p.member_user_id,
    'email', u.email,
    'you', p.member_user_id is not distinct from auth.uid(),
    'yeses', (select count(*) from runs r where r.lab_id = p.lab_id and r.confirmed_by = p.id and r.confirmer_attested_at is not null)
  )
  from people p
  left join auth.users u on u.id = p.member_user_id
  where p.lab_id = p_lab_id and is_lab_member(p_lab_id)
  order by lower(p.display_name), p.id
$$;

-- Says how a run went, as in 0034, now asking first (BL906) when leaving failed or odd would
-- remove a failure type as well as when it would remove a cause.
create or replace function set_run_status(p_run_id uuid, p_status run_status, p_clear_causes boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
  v_keeps boolean := p_status is not distinct from 'failed' or p_status is not distinct from 'odd';
begin
  if r.status is not distinct from p_status then
    return run_json(r.id);
  end if;
  if not v_keeps and (r.suspected_cause is not null or r.confirmed_cause is not null or r.taxonomy_version is not null)
    and not coalesce(p_clear_causes, false) then
    raise exception 'this run has a cause or a failure type written down' using errcode = 'BL906';
  end if;
  if v_keeps then
    update runs set status = p_status, status_by = auth.uid(), status_at = now() where id = r.id;
  else
    update runs set
      status = p_status, status_by = auth.uid(), status_at = case when p_status is not null then now() end,
      suspected_cause = null, suspected_by = null,
      confirmed_cause = null, confirmed_by = null, confirm_method = null, confirm_note = null,
      confirm_run = null, confirm_sha256 = null, confirmed_at = null, confirm_recorded_by = null,
      confirmer_attested_at = null,
      taxonomy_version = null, technique = null, failed_step = null, cause_category = null
    where id = r.id;
  end if;
  return run_json(r.id);
end
$$;

revoke all on function
  person_name_key(text), put_person_link(uuid, uuid, uuid), members_link_person(), people_link_changed(),
  member_person(uuid), link_checked(people, uuid), claim_person(uuid), link_person(uuid, uuid),
  unlink_person(uuid), lab_people(uuid), set_run_status(uuid, run_status, boolean)
from public, anon, authenticated;
grant execute on function
  claim_person(uuid), link_person(uuid, uuid), unlink_person(uuid), lab_people(uuid),
  set_run_status(uuid, run_status, boolean)
to authenticated;
