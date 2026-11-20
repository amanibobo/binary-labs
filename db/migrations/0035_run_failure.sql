-- The failure record (decisions.md, "the run record: the failure record"): what someone thinks
-- went wrong with a run, the cause once a person confirmed it, and the failure type from the
-- fixed list. Functions only; every column is in 0034. The log trigger records each change and
-- the sharing trigger turns a shared run's sharing off, so nothing here does either.
--
-- Errors: BL911 the confirmer isn't one of the lab's People. BL912 only the named confirmer's
-- own account can say yes. BL913 the run didn't fail and wasn't odd. BL914 what showed it
-- doesn't fit how it was confirmed. BL915 a confirmation dated in the future. BL916 a term
-- that isn't on the list. BL917 a text that is empty or too long.

-- A cause or a note as it is stored: trimmed, null when nothing is left. BL917 past p_max.
create function failure_text(p_text text, p_max int) returns text
language plpgsql immutable set search_path = public as $$
declare
  v text := nullif(btrim(p_text), '');
begin
  if length(v) > p_max then
    raise exception 'that text is too long' using errcode = 'BL917';
  end if;
  return v;
end
$$;

-- What someone thinks went wrong, or null to take it back. Anyone in the lab may write it.
create function set_suspected_cause(p_run_id uuid, p_cause text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
  v_cause text := failure_text(p_cause, 4000);
begin
  if p_cause is not null and v_cause is null then
    raise exception 'write the cause in a few words' using errcode = 'BL917';
  end if;
  if v_cause is not null and r.status is distinct from 'failed' and r.status is distinct from 'odd' then
    raise exception 'this run didn''t fail and isn''t odd' using errcode = 'BL913';
  end if;
  update runs set suspected_cause = v_cause, suspected_by = case when v_cause is null then null else auth.uid() end
  where id = r.id and suspected_cause is distinct from v_cause;
  return run_json(r.id);
end
$$;

-- The cause a person confirmed, who confirmed it (one of the lab's People, who may have no
-- account), how, and when. What showed it: for a control, one of this run's own files; for a
-- repeat, optionally the run that repeated it; the PI's opinion takes neither. A null cause
-- takes the confirmation back. The caller is recorded as who typed it in. If the caller is the
-- named confirmer, that is their own yes; anyone else's change waits for the confirmer's yes
-- again (attest_cause), because what they confirmed has changed.
create function confirm_cause(
  p_run_id uuid, p_cause text, p_person_id uuid, p_method confirm_method, p_note text,
  p_confirmed_at timestamptz, p_confirm_run uuid, p_confirm_sha256 text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
  v_cause text := failure_text(p_cause, 4000);
  v_note text := failure_text(p_note, 2000);
  v_at timestamptz := coalesce(p_confirmed_at, now());
  v_yours boolean;
begin
  if p_cause is null then
    update runs set
      confirmed_cause = null, confirmed_by = null, confirm_method = null, confirm_note = null,
      confirm_run = null, confirm_sha256 = null, confirmed_at = null, confirm_recorded_by = null,
      confirmer_attested_at = null
    where id = r.id and confirmed_cause is not null;
    return run_json(r.id);
  end if;
  if v_cause is null then
    raise exception 'write the cause in a few words' using errcode = 'BL917';
  end if;
  if r.status is distinct from 'failed' and r.status is distinct from 'odd' then
    raise exception 'this run didn''t fail and isn''t odd' using errcode = 'BL913';
  end if;
  select p.member_user_id is not distinct from auth.uid() into v_yours
  from people p where p.id = p_person_id and p.lab_id = r.lab_id;
  if not found then
    raise exception 'no such person in this lab' using errcode = 'BL911';
  end if;
  if p_method is null
    or (p_method = 'control' and (p_confirm_run is not null or p_confirm_sha256 is null
      or not exists (select 1 from run_files f where f.run_id = r.id and f.sha256 = p_confirm_sha256)))
    or (p_method = 'repeat' and (p_confirm_sha256 is not null or p_confirm_run = r.id
      or (p_confirm_run is not null and not exists (select 1 from runs o where o.id = p_confirm_run and o.lab_id = r.lab_id))))
    or (p_method = 'pi_opinion' and (p_confirm_run is not null or p_confirm_sha256 is not null)) then
    raise exception 'what showed it doesn''t fit how it was confirmed' using errcode = 'BL914';
  end if;
  -- A few minutes' grace for a browser clock running ahead of ours.
  if v_at > now() + interval '5 minutes' then
    raise exception 'a confirmation can''t be dated in the future' using errcode = 'BL915';
  end if;
  update runs set
    confirmed_cause = v_cause, confirmed_by = p_person_id, confirm_method = p_method, confirm_note = v_note,
    confirm_run = p_confirm_run, confirm_sha256 = p_confirm_sha256, confirmed_at = v_at,
    confirm_recorded_by = auth.uid(),
    confirmer_attested_at = case when v_yours then now() end
  where id = r.id
    and (confirmed_cause, confirmed_by, confirm_method, confirm_note, confirm_run, confirm_sha256, confirmed_at)
      is distinct from (v_cause, p_person_id, p_method, v_note, p_confirm_run, p_confirm_sha256, v_at);
  return run_json(r.id);
end
$$;

-- "Yes, I confirmed this", from the named confirmer's own account. BL912 for anyone else, and
-- when there is no confirmed cause (so no confirmer) to say yes to.
create function attest_cause(p_run_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
begin
  if not exists (
    select 1 from people p where p.id = r.confirmed_by and p.lab_id = r.lab_id and p.member_user_id = auth.uid()
  ) then
    raise exception 'only the named confirmer can say this' using errcode = 'BL912';
  end if;
  update runs set confirmer_attested_at = now() where id = r.id and confirmer_attested_at is null;
  return run_json(r.id);
end
$$;

-- The failure type from the fixed list: what kind of experiment, the step that went wrong and
-- the kind of problem, each optional, coded against one version of the list. All three null
-- clears it. BL916: a version or a term that isn't on the list, or a term in the wrong place.
create function set_failure_type(p_run_id uuid, p_version smallint, p_technique text, p_step text, p_cause text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
  v_empty boolean := p_technique is null and p_step is null and p_cause is null;
begin
  if not v_empty then
    if r.status is distinct from 'failed' and r.status is distinct from 'odd' then
      raise exception 'this run didn''t fail and isn''t odd' using errcode = 'BL913';
    end if;
    if (p_technique is not null and not exists (select 1 from failure_terms t where t.version = p_version and t.code = p_technique and t.code like 'tech.%'))
      or (p_step is not null and not exists (select 1 from failure_terms t where t.version = p_version and t.code = p_step and t.code like 'step.%'))
      or (p_cause is not null and not exists (select 1 from failure_terms t where t.version = p_version and t.code = p_cause and t.code like 'cause.%')) then
      raise exception 'that isn''t on the failure list' using errcode = 'BL916';
    end if;
  end if;
  update runs set
    taxonomy_version = case when v_empty then null else p_version end,
    technique = p_technique, failed_step = p_step, cause_category = p_cause
  where id = r.id
    and (taxonomy_version, technique, failed_step, cause_category)
      is distinct from (case when v_empty then null else p_version end, p_technique, p_step, p_cause);
  return run_json(r.id);
end
$$;

-- Who can be named as a run's confirmer: its lab's People. `you` is the caller's own row;
-- `account` says the person can sign in, so they can say yes themselves. Read under row
-- security, so it is empty for anyone outside the run's lab.
create function confirmer_choices(p_run_id uuid) returns setof jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'id', p.id,
    'name', p.display_name,
    'you', auth.uid() is not null and p.member_user_id is not distinct from auth.uid(),
    'account', p.member_user_id is not null
  )
  from runs r join people p on p.lab_id = r.lab_id
  where r.id = p_run_id
  order by lower(p.display_name), p.id
$$;

-- The newest version of the failure list, with its terms in picker order and whether a
-- working scientist has signed it off.
create function failure_list() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'version', t.version,
    'signed_off_at', t.signed_off_at,
    'signed_off_by', t.signed_off_by,
    'terms', coalesce((
      select jsonb_agg(jsonb_build_object('version', f.version, 'code', f.code, 'label', f.label, 'hint', f.hint, 'position', f.position)
        order by split_part(f.code, '.', 1), f.position)
      from failure_terms f where f.version = t.version
    ), '[]')
  )
  from failure_taxonomies t
  order by t.version desc
  limit 1
$$;

revoke all on function
  failure_text(text, int), set_suspected_cause(uuid, text),
  confirm_cause(uuid, text, uuid, confirm_method, text, timestamptz, uuid, text), attest_cause(uuid),
  set_failure_type(uuid, smallint, text, text, text), confirmer_choices(uuid), failure_list()
from public, anon, authenticated;
grant execute on function
  set_suspected_cause(uuid, text),
  confirm_cause(uuid, text, uuid, confirm_method, text, timestamptz, uuid, text), attest_cause(uuid),
  set_failure_type(uuid, smallint, text, text, text), confirmer_choices(uuid), failure_list()
to authenticated;
