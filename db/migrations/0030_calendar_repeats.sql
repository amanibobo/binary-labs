-- The calendar, round 2 (decisions.md, "the calendar: repeats, reminders, a feed and notes"):
--
-- Repeats. A series holds the rule; every occurrence is its own calendar_entries row, made when
-- the rule is set, so each one can differ and everything that reads plans (the grids, overlaps,
-- a protocol's coming entries, the feed) reads them unchanged. A rule runs up to a year.
-- occurrence_on is the day the rule put a row on, which stays when the row is moved.
--
-- Reminders are each member's own, per entry. The app shows them; there's no mail path yet.
--
-- A feed is an .ics address per member and lab, outside the session: the address carries a
-- secret whose sha256 is all the database keeps. Making a new one stops the old.
--
-- Notes: the pages of a live note are one file on the calendar, on its first page's day.

alter type audit_action add value if not exists 'calendar.repeat';
alter type audit_action add value if not exists 'calendar.feed_reset';

create table calendar_series (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  every text not null check (every in ('day', 'week', 'month')),
  -- Every 1 to 4 weeks; days and months step by one.
  step int not null default 1 check (step between 1 and 4),
  -- 0 is Sunday. Weekly rules only.
  weekdays smallint[] not null default '{}' check (weekdays <@ '{0,1,2,3,4,5,6}'::smallint[]),
  first_on date not null,
  until_on date not null,
  -- Timed occurrences keep their wall-clock time here, so 10 am stays 10 am across DST.
  time_zone text not null check (length(time_zone) between 1 and 64),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, lab_id),
  check (until_on >= first_on and until_on - first_on <= 366),
  check ((every = 'week') = (cardinality(weekdays) > 0)),
  check (every = 'week' or step = 1)
);

alter table calendar_series enable row level security;
create policy calendar_series_select on calendar_series for select using (is_lab_member(lab_id));

alter table calendar_entries
  add column series_id uuid,
  add column occurrence_on date,
  add foreign key (series_id, lab_id) references calendar_series (id, lab_id) on delete cascade,
  add check ((series_id is null) = (occurrence_on is null));
create unique index calendar_entries_series_idx on calendar_entries (series_id, occurrence_on) where series_id is not null;

create table calendar_reminders (
  entry_id uuid not null,
  lab_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Before the start; an all-day entry starts at 9 am where the member is.
  minutes_before int not null check (minutes_before between 0 and 40320),
  -- The moment it was last shown for, so it shows once, and again if the entry moves.
  shown_for timestamptz,
  primary key (entry_id, user_id, minutes_before),
  foreign key (entry_id, lab_id) references calendar_entries (id, lab_id) on delete cascade
);
create index calendar_reminders_user_idx on calendar_reminders (user_id, lab_id);

alter table calendar_reminders enable row level security;
create policy calendar_reminders_select on calendar_reminders for select
  using (user_id = auth.uid() and is_lab_member(lab_id));

create table calendar_feeds (
  lab_id uuid not null references labs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (lab_id, user_id)
);

alter table calendar_feeds enable row level security;
create policy calendar_feeds_select on calendar_feeds for select
  using (user_id = auth.uid() and is_lab_member(lab_id));

-- One entry as the web app reads it, now with its repeat and the reader's reminders.
create or replace function calendar_entry_json(e calendar_entries) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'id', e.id,
    'title', e.title,
    'notes', e.notes,
    'starts_on', e.starts_on,
    'ends_on', e.ends_on,
    'starts_at', e.starts_at,
    'ends_at', e.ends_at,
    'experiment', (select jsonb_build_object('id', x.id, 'name', x.name) from experiments x where x.id = e.experiment_id),
    'protocol', (
      select jsonb_build_object('id', p.id, 'title', v.title, 'archived', p.archived_at is not null)
      from protocols p join protocol_versions v on v.id = p.current_version_id
      where p.id = e.protocol_id
    ),
    'instrument', (
      select jsonb_build_object('id', i.id, 'name', i.name, 'revoked', i.revoked_at is not null)
      from instruments i where i.id = e.instrument_id
    ),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by array_position(e.person_ids, p.id))
      from people p where p.id = any (e.person_ids) and p.lab_id = e.lab_id
    ), '[]'::jsonb),
    'repeat', (
      select jsonb_build_object(
        'series_id', s.id, 'every', s.every, 'step', s.step, 'weekdays', to_jsonb(s.weekdays),
        'first_on', s.first_on, 'until_on', s.until_on, 'occurrence_on', e.occurrence_on,
        'count', (select count(*) from calendar_entries o where o.series_id = s.id)
      )
      from calendar_series s where s.id = e.series_id
    ),
    'reminders', coalesce((
      select jsonb_agg(r.minutes_before order by r.minutes_before)
      from calendar_reminders r where r.entry_id = e.id and r.user_id = auth.uid()
    ), '[]'::jsonb),
    'created_by', e.created_by,
    'created_at', e.created_at,
    'updated_at', e.updated_at
  )
$$;

-- The days a rule puts an occurrence on, from its first day to its last, both included.
create function calendar_repeat_days(p_every text, p_step int, p_weekdays smallint[], p_first date, p_until date)
returns setof date
language sql immutable set search_path = public as $$
  select d::date
  from generate_series(p_first::timestamp, p_until::timestamp, interval '1 day') d
  where case p_every
    when 'day' then true
    when 'week' then extract(dow from d)::smallint = any (p_weekdays)
      and ((d::date - (p_first - extract(dow from p_first)::int)) / 7) % p_step = 0
    when 'month' then extract(day from d) = extract(day from p_first)
    else false
  end
$$;

-- Where an occurrence on p_day sits, placed as t sits on its own occurrence day: the same days
-- after it, the same wall-clock time where the series is, and the same length.
create function calendar_place(
  t calendar_entries,
  p_day date,
  p_tz text,
  out starts_on date,
  out ends_on date,
  out starts_at timestamptz,
  out ends_at timestamptz
)
language sql stable set search_path = public as $$
  select
    p_day + (t.starts_on - t.occurrence_on),
    p_day + (t.ends_on - t.occurrence_on),
    ((p_day + ((t.starts_at at time zone p_tz)::date - t.occurrence_on)) + (t.starts_at at time zone p_tz)::time) at time zone p_tz,
    (((p_day + ((t.starts_at at time zone p_tz)::date - t.occurrence_on)) + (t.starts_at at time zone p_tz)::time) at time zone p_tz)
      + (t.ends_at - t.starts_at)
$$;

-- The entry, locked, for a write by a member. Null when it's gone.
create function calendar_lock_entry(p_entry_id uuid) returns calendar_entries
language plpgsql security definer set search_path = public as $$
declare
  t calendar_entries;
begin
  select * into t from calendar_entries where id = p_entry_id for update;
  if not found then
    return null;
  end if;
  if not is_lab_member(t.lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  return t;
end
$$;

-- Sets how an entry repeats, from this occurrence on; null stops it repeating. Occurrences
-- before this one keep the old rule. Later ones the new rule also lands on are kept as they
-- are, the rest go, and the new rule's other days get a copy of this one (with its reminders).
-- Answers {kind: saved|stale, entry}, as a save does. BL403 a repeat longer than a year.
create function calendar_repeat(p_entry_id uuid, p_based_on timestamptz, p_rule jsonb, p_tz text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t calendar_entries;
  v_day date;
  v_old uuid;
  v_new uuid;
  v_every text;
  v_step int;
  v_weekdays smallint[];
  v_until date;
  -- Copies and kept occurrences come after this day, so none lands on one the old rule keeps.
  v_floor date;
begin
  t := calendar_lock_entry(p_entry_id);
  if t.id is null then
    return jsonb_build_object('kind', 'stale', 'entry', null);
  end if;
  if t.updated_at <> p_based_on then
    return jsonb_build_object('kind', 'stale', 'entry', calendar_entry_json(t));
  end if;
  perform calendar_check_range(current_date, current_date, p_tz);
  v_day := coalesce(t.starts_on, (t.starts_at at time zone p_tz)::date);
  v_old := t.series_id;
  v_floor := greatest(v_day, t.occurrence_on);

  if p_rule is not null then
    v_every := p_rule ->> 'every';
    v_step := coalesce((p_rule ->> 'step')::int, 1);
    v_weekdays := coalesce(array(select jsonb_array_elements_text(p_rule -> 'weekdays')::smallint), '{}');
    v_until := (p_rule ->> 'until')::date;
    if v_until is null or v_until < v_day or v_until - v_day > 366 then
      raise exception 'a repeat runs up to a year' using errcode = 'BL403';
    end if;
    insert into calendar_series (lab_id, every, step, weekdays, first_on, until_on, time_zone)
    values (t.lab_id, v_every, v_step, v_weekdays, v_day, v_until, p_tz)
    returning id into v_new;
  end if;

  if v_old is not null then
    if v_new is not null then
      update calendar_entries set series_id = v_new
      where series_id = v_old and occurrence_on > v_floor
        and occurrence_on in (select calendar_repeat_days(v_every, v_step, v_weekdays, v_day, v_until));
    end if;
    delete from calendar_entries where series_id = v_old and occurrence_on > t.occurrence_on and id <> t.id;
  end if;

  update calendar_entries
  set series_id = v_new, occurrence_on = case when v_new is null then null else v_day end
  where id = t.id
  returning * into t;

  if v_old is not null then
    if exists (select 1 from calendar_entries where series_id = v_old) then
      update calendar_series set until_on = greatest(first_on, (select max(occurrence_on) from calendar_entries where series_id = v_old))
      where id = v_old;
    else
      delete from calendar_series where id = v_old;
    end if;
  end if;

  if v_new is not null then
    insert into calendar_entries (
      lab_id, title, notes, starts_on, ends_on, starts_at, ends_at,
      experiment_id, protocol_id, instrument_id, person_ids, created_by, series_id, occurrence_on
    )
    select t.lab_id, t.title, t.notes, p.starts_on, p.ends_on, p.starts_at, p.ends_at,
      t.experiment_id, t.protocol_id, t.instrument_id, t.person_ids, auth.uid(), v_new, d
    from calendar_repeat_days(v_every, v_step, v_weekdays, v_day, v_until) d
    cross join lateral calendar_place(t, d, p_tz) p
    where d > v_floor and not exists (select 1 from calendar_entries o where o.series_id = v_new and o.occurrence_on = d);
    insert into calendar_reminders (entry_id, lab_id, user_id, minutes_before)
    select o.id, o.lab_id, r.user_id, r.minutes_before
    from calendar_entries o join calendar_reminders r on r.entry_id = t.id
    where o.series_id = v_new and o.id <> t.id
    on conflict do nothing;
  end if;

  insert into audit_log (lab_id, actor, action, target) values (t.lab_id, auth.uid(), 'calendar.repeat', t.id::text);
  return jsonb_build_object('kind', 'saved', 'entry', calendar_entry_json(t));
end
$$;

-- Saves a change to every occurrence of the entry's series. Only what changed spreads: a new
-- title retitles them all and leaves their own times alone; new times place every occurrence
-- as this one now sits on its day. p_draft holds the columns a save writes.
create function calendar_save_series(p_entry_id uuid, p_based_on timestamptz, p_draft jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_old calendar_entries;
  t calendar_entries;
  d calendar_entries;
  v_tz text;
  v_when boolean;
begin
  v_old := calendar_lock_entry(p_entry_id);
  if v_old.id is null then
    return jsonb_build_object('kind', 'stale', 'entry', null);
  end if;
  if v_old.updated_at <> p_based_on then
    return jsonb_build_object('kind', 'stale', 'entry', calendar_entry_json(v_old));
  end if;
  if v_old.series_id is null then
    raise exception 'this entry doesn''t repeat' using errcode = '22023';
  end if;
  d := jsonb_populate_record(null::calendar_entries, p_draft);
  update calendar_entries
  set title = d.title, notes = d.notes, starts_on = d.starts_on, ends_on = d.ends_on, starts_at = d.starts_at,
    ends_at = d.ends_at, experiment_id = d.experiment_id, protocol_id = d.protocol_id, instrument_id = d.instrument_id,
    person_ids = coalesce(d.person_ids, '{}')
  where id = p_entry_id
  returning * into t;
  select s.time_zone into v_tz from calendar_series s where s.id = t.series_id;
  v_when := (t.starts_on, t.ends_on, t.starts_at, t.ends_at) is distinct from (v_old.starts_on, v_old.ends_on, v_old.starts_at, v_old.ends_at);

  update calendar_entries o
  set title = case when t.title is distinct from v_old.title then t.title else o.title end,
    notes = case when t.notes is distinct from v_old.notes then t.notes else o.notes end,
    experiment_id = case when t.experiment_id is distinct from v_old.experiment_id then t.experiment_id else o.experiment_id end,
    protocol_id = case when t.protocol_id is distinct from v_old.protocol_id then t.protocol_id else o.protocol_id end,
    instrument_id = case when t.instrument_id is distinct from v_old.instrument_id then t.instrument_id else o.instrument_id end,
    person_ids = case when t.person_ids is distinct from v_old.person_ids then t.person_ids else o.person_ids end,
    (starts_on, ends_on, starts_at, ends_at) = (
      select
        case when v_when then p.starts_on else o.starts_on end,
        case when v_when then p.ends_on else o.ends_on end,
        case when v_when then p.starts_at else o.starts_at end,
        case when v_when then p.ends_at else o.ends_at end
      from calendar_place(t, o.occurrence_on, v_tz) p
    )
  where o.series_id = t.series_id and o.id <> t.id;

  return jsonb_build_object('kind', 'saved', 'entry', calendar_entry_json(t));
end
$$;

-- Deletes every occurrence of the entry's series; answers how many went.
create function calendar_delete_series(p_entry_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  t calendar_entries;
  v_count int;
begin
  t := calendar_lock_entry(p_entry_id);
  if t.id is null then
    return 0;
  end if;
  if t.series_id is null then
    delete from calendar_entries where id = t.id;
    return 1;
  end if;
  select count(*) into v_count from calendar_entries where series_id = t.series_id;
  delete from calendar_series where id = t.series_id;
  return v_count;
end
$$;

-- The caller's reminders on an entry, or on every occurrence of its series, become p_minutes.
-- One already there keeps when it was shown.
create function calendar_set_reminders(p_entry_id uuid, p_minutes int[], p_all boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t calendar_entries;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_minutes is null or cardinality(p_minutes) > 5
    or exists (select 1 from unnest(p_minutes) m where m is null or m < 0 or m > 40320) then
    raise exception 'up to five reminders, up to four weeks before' using errcode = '22023';
  end if;
  t := calendar_lock_entry(p_entry_id);
  if t.id is null then
    return null;
  end if;
  with targets as (
    select e.id, e.lab_id from calendar_entries e
    where e.id = t.id or (p_all and t.series_id is not null and e.series_id = t.series_id)
  ),
  gone as (
    delete from calendar_reminders r using targets x
    where r.entry_id = x.id and r.user_id = auth.uid() and r.minutes_before <> all (p_minutes)
  )
  insert into calendar_reminders (entry_id, lab_id, user_id, minutes_before)
  select x.id, x.lab_id, auth.uid(), m from targets x cross join (select distinct unnest(p_minutes) as m) ms
  on conflict do nothing;
  return calendar_entry_json(t);
end
$$;

-- The caller's reminders that are due where they are: past their moment and before the entry
-- ends, and not yet shown for that moment. Soonest first.
create function calendar_due_reminders(p_lab_id uuid, p_tz text) returns setof jsonb
language plpgsql stable security invoker set search_path = public as $$
begin
  perform calendar_check_range(current_date, current_date, p_tz);
  return query
  select jsonb_build_object('entry', calendar_entry_json(e), 'minutes', r.minutes_before, 'at', f.fire)
  from calendar_reminders r
  join calendar_entries e on e.id = r.entry_id
  cross join lateral (
    select coalesce(e.starts_at, (e.starts_on + time '09:00') at time zone p_tz) as base,
      coalesce(e.ends_at, (e.ends_on + 1)::timestamp at time zone p_tz) as ends
  ) b
  cross join lateral (select b.base - make_interval(mins => r.minutes_before) as fire) f
  where r.user_id = auth.uid() and r.lab_id = p_lab_id
    and f.fire <= now() and b.ends > now()
    and r.shown_for is distinct from f.fire
  order by f.fire, e.id
  limit 20;
end
$$;

create function calendar_reminder_shown(p_entry_id uuid, p_minutes int, p_at timestamptz) returns void
language sql security definer set search_path = public as $$
  update calendar_reminders set shown_for = p_at
  where entry_id = p_entry_id and user_id = auth.uid() and minutes_before = p_minutes
$$;

-- A new feed address for the caller in this lab; the old one stops working.
create function calendar_feed_reset(p_lab_id uuid, p_token_hash text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_at timestamptz;
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'the token hash must be sha256 hex' using errcode = '22023';
  end if;
  insert into calendar_feeds (lab_id, user_id, token_hash) values (p_lab_id, auth.uid(), p_token_hash)
  on conflict (lab_id, user_id) do update set token_hash = excluded.token_hash, created_at = now()
  returning created_at into v_at;
  insert into audit_log (lab_id, actor, action, target) values (p_lab_id, auth.uid(), 'calendar.feed_reset', auth.uid()::text);
  return v_at;
end
$$;

-- What a feed address shows, for the service role only: the lab's plans from 90 days back to
-- 400 days on, with the member's own reminders. Null once the address was replaced, the
-- member left, or the lab is being deleted.
create function calendar_feed(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  f calendar_feeds;
  v_lab text;
begin
  select cf.* into f from calendar_feeds cf
  join members m on m.lab_id = cf.lab_id and m.user_id = cf.user_id
  join labs l on l.id = cf.lab_id and l.deletion_requested_at is null
  where cf.token_hash = p_token_hash;
  if not found then
    return null;
  end if;
  select name into v_lab from labs where id = f.lab_id;
  return jsonb_build_object(
    'lab', v_lab,
    'entries', coalesce((
      select jsonb_agg(
        calendar_entry_json(e) || jsonb_build_object('reminders', coalesce((
          select jsonb_agg(r.minutes_before order by r.minutes_before)
          from calendar_reminders r where r.entry_id = e.id and r.user_id = f.user_id
        ), '[]'::jsonb))
        order by coalesce(e.starts_at, e.starts_on::timestamp at time zone 'UTC'), e.id)
      from (
        select * from calendar_entries e
        where e.lab_id = f.lab_id
          and coalesce(e.ends_at, (e.ends_on + 1)::timestamp at time zone 'UTC') > now() - interval '90 days'
          and coalesce(e.starts_at, e.starts_on::timestamp at time zone 'UTC') < now() + interval '400 days'
        order by coalesce(e.starts_at, e.starts_on::timestamp at time zone 'UTC'), e.id
        limit 5000
      ) e
    ), '[]'::jsonb)
  );
end
$$;

-- calendar_files as 0017 has it, with the pages of a live note folded into its first page.
create or replace function calendar_files(
  p_lab_id uuid,
  p_from date,
  p_to date,
  p_tz text,
  p_experiment_id uuid default null,
  p_person_id uuid default null,
  p_instrument_id uuid default null
)
returns table (sha256 text, day date, kind text, group_id uuid, group_name text, name text, modified_at timestamptz)
language plpgsql stable security invoker set search_path = public as $$
declare
  v_from timestamptz;
  v_to timestamptz;
begin
  perform calendar_check_range(p_from, p_to, p_tz);
  v_from := p_from::timestamp at time zone p_tz;
  v_to := (p_to + 1)::timestamp at time zone p_tz;
  return query
  with dated_shas as (
    select l.sha256 from labels l
    where l.lab_id = p_lab_id and l.date between p_from and p_to
    union
    select fl.sha256 from file_locations fl
    where fl.lab_id = p_lab_id and fl.deleted_at is null and fl.sha256 is not null
      and fl.modified_at >= v_from and fl.modified_at < v_to
  ),
  candidates as (
    select distinct coalesce(cover.sha256, c.sha256) as sha256
    from dated_shas c
    left join note_pages np on np.lab_id = p_lab_id and np.sha256 = c.sha256 and np.live
    left join lateral (
      select x.sha256 from note_pages x where x.note_id = np.note_id and x.live order by x.position limit 1
    ) cover on true
  ),
  files as (
    select c.sha256, l.date as label_date, l.experiment_id, l.person_id, l.instrument, l.clean_name,
      latest.source_id, latest.source_kind, latest.modified_at, latest.original_name
    from candidates c
    left join labels l on l.lab_id = p_lab_id and l.sha256 = c.sha256
    cross join lateral (
      select fl.source_id, s.kind::text as source_kind, fl.modified_at, fl.original_name
      from file_locations fl join sources s on s.id = fl.source_id
      where fl.lab_id = p_lab_id and fl.sha256 = c.sha256 and fl.deleted_at is null
        and not exists (select 1 from talk_throughs t where t.location_id = fl.id)
      order by fl.modified_at desc, fl.id
      limit 1
    ) latest
  ),
  dated as (
    select f.*, coalesce(f.label_date, (f.modified_at at time zone p_tz)::date) as on_day from files f
  )
  select d.sha256, d.on_day,
    case d.source_kind when 'upload' then 'upload' when 'instrument' then 'instrument' else 'file' end,
    case when d.source_kind = 'instrument' then i.id else e.id end,
    case when d.source_kind = 'instrument' then i.name else e.name end,
    coalesce(d.clean_name, d.original_name),
    d.modified_at
  from dated d
  left join experiments e on e.id = d.experiment_id
  left join instruments i on i.source_id = d.source_id
  where d.on_day between p_from and p_to
    and (p_experiment_id is null or d.experiment_id = p_experiment_id)
    and (p_person_id is null or d.person_id = p_person_id)
    and (p_instrument_id is null or exists (
      select 1 from instruments fi
      where fi.id = p_instrument_id and fi.lab_id = p_lab_id
        and (fi.source_id = d.source_id or lower(d.instrument) = lower(fi.name))
    ));
end
$$;

revoke all on calendar_series, calendar_reminders, calendar_feeds from anon, authenticated;
revoke all on function
  calendar_repeat_days(text, int, smallint[], date, date), calendar_place(calendar_entries, date, text),
  calendar_lock_entry(uuid), calendar_repeat(uuid, timestamptz, jsonb, text),
  calendar_save_series(uuid, timestamptz, jsonb), calendar_delete_series(uuid),
  calendar_set_reminders(uuid, int[], boolean), calendar_due_reminders(uuid, text),
  calendar_reminder_shown(uuid, int, timestamptz), calendar_feed_reset(uuid, text), calendar_feed(text)
from public, anon, authenticated;
grant select on calendar_series, calendar_reminders to authenticated;
grant select (lab_id, user_id, created_at) on calendar_feeds to authenticated;
-- An occurrence deleted on its own can be put back in its series (Undo).
grant insert (series_id, occurrence_on) on calendar_entries to authenticated;
grant execute on function
  calendar_repeat_days(text, int, smallint[], date, date), calendar_place(calendar_entries, date, text),
  calendar_repeat(uuid, timestamptz, jsonb, text), calendar_save_series(uuid, timestamptz, jsonb),
  calendar_delete_series(uuid), calendar_set_reminders(uuid, int[], boolean), calendar_due_reminders(uuid, text),
  calendar_reminder_shown(uuid, int, timestamptz), calendar_feed_reset(uuid, text)
to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function calendar_feed(text) to service_role;
  end if;
end
$$;
