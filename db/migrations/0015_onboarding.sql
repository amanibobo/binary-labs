-- Our own onboarding (decisions.md, "our own onboarding instead of Frigade"). What a person has
-- seen (the welcome, the tour, each hint) is theirs alone, so it lives in one row per user and
-- goes when the user does. It holds no lab content, so lab deletion has nothing to remove here.
-- The getting-started checklist is never stored: onboarding_progress works it out from what
-- the lab has actually done, so it can't drift from the truth.

create table onboarding (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  welcome_seen_at timestamptz,
  -- The furthest tour step reached, counted from 1, and how the last tour ended.
  tour_step smallint not null default 0 check (tour_step between 0 and 20),
  tour_ended text check (tour_ended in ('done', 'skipped')),
  tour_ended_at timestamptz,
  checklist_hidden_at timestamptz,
  hints_seen text[] not null default '{}' check (cardinality(hints_seen) <= 20),
  updated_at timestamptz not null default now(),
  check ((tour_ended is null) = (tour_ended_at is null))
);

alter table onboarding enable row level security;
create policy onboarding_select on onboarding for select using (user_id = auth.uid());
create policy onboarding_insert on onboarding for insert with check (user_id = auth.uid());
create policy onboarding_update on onboarding for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Records one thing the person did with onboarding. Safe to repeat: the welcome and a hint stay
-- seen, the tour step only moves forward, and a finished tour stays finished unless it is taken
-- again. Runs as the caller, so RLS keeps everyone to their own row.
-- Kinds: welcome, tour_step (value: the step), tour_done, tour_skipped, hint (value: its id),
-- hide_checklist.
create function note_onboarding(p_kind text, p_value text default null) returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_kind not in ('welcome', 'tour_step', 'tour_done', 'tour_skipped', 'hint', 'hide_checklist') then
    raise exception 'unknown onboarding kind %', p_kind using errcode = '22023';
  end if;
  if p_kind = 'tour_step' and (p_value is null or p_value !~ '^[0-9]{1,2}$' or p_value::int > 20) then
    raise exception 'bad tour step' using errcode = '22023';
  end if;
  if p_kind = 'hint' and (p_value is null or p_value !~ '^[a-z][a-z-]{0,39}$') then
    raise exception 'bad hint' using errcode = '22023';
  end if;

  insert into onboarding (user_id) values (v_user) on conflict (user_id) do nothing;
  update onboarding set
    welcome_seen_at = case when p_kind = 'welcome' then coalesce(welcome_seen_at, now()) else welcome_seen_at end,
    -- Starting the tour again (step 1) clears how it last ended.
    tour_step = case when p_kind = 'tour_step' then greatest(tour_step, p_value::int) else tour_step end,
    tour_ended = case
      when p_kind = 'tour_done' then 'done'
      when p_kind = 'tour_skipped' then coalesce(nullif(tour_ended, 'skipped'), 'skipped')
      when p_kind = 'tour_step' and p_value = '1' then null
      else tour_ended end,
    tour_ended_at = case
      when p_kind = 'tour_done' then now()
      when p_kind = 'tour_skipped' then case when tour_ended = 'done' then tour_ended_at else now() end
      when p_kind = 'tour_step' and p_value = '1' then null
      else tour_ended_at end,
    checklist_hidden_at = case when p_kind = 'hide_checklist' then coalesce(checklist_hidden_at, now()) else checklist_hidden_at end,
    hints_seen = case
      when p_kind = 'hint' and not (p_value = any (hints_seen)) then hints_seen || p_value
      else hints_seen end,
    updated_at = now()
  where user_id = v_user;
end
$$;

-- When the caller's lab, and the caller in it, first did each thing on the checklist; null for
-- what hasn't happened. Lab facts (files, an invite, a protocol) count whoever did them; the
-- rest count only the caller. Admins can't otherwise read who searched, so this runs as
-- definer and answers only for the caller, in a lab they belong to.
-- Completion time for the pilot's time-to-first-value metric is the latest of these, minus
-- joined_at.
create function onboarding_progress(p_lab_id uuid)
returns table (
  joined_at timestamptz,
  dropbox_at timestamptz,
  lab_upload_at timestamptz,
  invited_at timestamptz,
  protocol_at timestamptz,
  searched_at timestamptz,
  corrected_at timestamptz,
  uploaded_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    (select m.created_at from members m where m.lab_id = p_lab_id and m.user_id = auth.uid()),
    (select min(s.created_at) from sources s where s.lab_id = p_lab_id and s.kind = 'dropbox' and s.root_path is not null),
    (select min(u.uploaded_at) from uploads u where u.lab_id = p_lab_id),
    -- The lab's second member: an invite creates their membership straight away.
    (select m.created_at from members m where m.lab_id = p_lab_id order by m.created_at offset 1 limit 1),
    (select min(p.created_at) from protocols p where p.lab_id = p_lab_id),
    (select min(a.at) from audit_log a where a.lab_id = p_lab_id and a.actor = auth.uid() and a.action = 'search'),
    (select min(c.at) from corrections c where c.lab_id = p_lab_id and c.user_id = auth.uid() and c.undoes is null),
    (select min(u.uploaded_at) from uploads u where u.lab_id = p_lab_id and u.uploaded_by = auth.uid())
  where is_lab_member(p_lab_id)
$$;

revoke all on onboarding from anon, authenticated;
revoke all on function note_onboarding(text, text), onboarding_progress(uuid) from public, anon, authenticated;
grant select on onboarding to authenticated;
grant insert (user_id) on onboarding to authenticated;
grant update (welcome_seen_at, tour_step, tour_ended, tour_ended_at, checklist_hidden_at, hints_seen, updated_at)
  on onboarding to authenticated;
grant execute on function note_onboarding(text, text), onboarding_progress(uuid) to authenticated;
