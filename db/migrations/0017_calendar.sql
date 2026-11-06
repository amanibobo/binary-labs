-- The lab calendar (decisions.md, "the lab calendar"). Two halves on one grid:
--
-- The record is never stored. calendar_files and calendar_events work out what happened on each
-- day from dates the lab already has (a file's label date, else the day its newest copy was
-- modified; when a protocol version, a chart or a talk-through was made), and calendar_record
-- counts them per day, kind and experiment, so a month of a 20,000-file lab is a few hundred
-- rows. Moments are put on the viewer's day, in the time zone they pass in.
--
-- Plans are rows in calendar_entries that members write: a title, either dates (all day) or
-- instants (timed), notes, and links to an experiment, a protocol, an instrument and people.

-- A new enum value can't be used in the transaction that adds it; only plpgsql bodies name these.
alter type audit_action add value if not exists 'calendar.create';
alter type audit_action add value if not exists 'calendar.save';
alter type audit_action add value if not exists 'calendar.delete';

create table calendar_entries (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  notes text check (notes is null or length(notes) <= 10000),
  -- All day: calendar days that never shift, the end included. Timed: instants, the end excluded.
  starts_on date,
  ends_on date,
  starts_at timestamptz,
  ends_at timestamptz,
  experiment_id uuid,
  protocol_id uuid,
  instrument_id uuid,
  -- people rows in this lab, kept in the order they were added. An array keeps an entry one row,
  -- so a save is one statement; a person an admin removes later is skipped when read.
  person_ids uuid[] not null default '{}' check (cardinality(person_ids) <= 20),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, lab_id),
  foreign key (experiment_id, lab_id) references experiments (id, lab_id) on delete set null (experiment_id),
  foreign key (protocol_id, lab_id) references protocols (id, lab_id) on delete set null (protocol_id),
  foreign key (instrument_id, lab_id) references instruments (id, lab_id) on delete set null (instrument_id),
  check (
    (starts_on is not null and ends_on is not null and starts_at is null and ends_at is null
      and ends_on >= starts_on and ends_on - starts_on < 366)
    or (starts_at is not null and ends_at is not null and starts_on is null and ends_on is null
      and ends_at > starts_at and ends_at - starts_at <= interval '31 days')
  )
);
create index calendar_entries_days_idx on calendar_entries (lab_id, starts_on, ends_on) where starts_on is not null;
create index calendar_entries_times_idx on calendar_entries (lab_id, starts_at, ends_at) where starts_at is not null;
create index calendar_entries_protocol_idx on calendar_entries (protocol_id) where protocol_id is not null;
create index calendar_entries_instrument_idx on calendar_entries (instrument_id) where instrument_id is not null;

-- The record reads files by label date.
create index labels_lab_date_idx on labels (lab_id, date) where date is not null;

alter table calendar_entries enable row level security;
create policy calendar_entries_select on calendar_entries for select using (is_lab_member(lab_id));
create policy calendar_entries_insert on calendar_entries for insert
  with check (is_lab_member(lab_id) and created_by = auth.uid());
create policy calendar_entries_update on calendar_entries for update
  using (is_lab_member(lab_id)) with check (is_lab_member(lab_id));
create policy calendar_entries_delete on calendar_entries for delete using (is_lab_member(lab_id));

-- Links stay inside the entry's lab. A link that changes is checked; one already there is kept,
-- so an entry made before its protocol was archived or its instrument revoked still saves.
-- BL103 a protocol that isn't this lab's, BL102 an archived protocol, BL401 an experiment,
-- person or instrument that isn't this lab's, BL402 a revoked instrument.
create function calendar_entries_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old_people uuid[] := '{}';
  v_kept uuid[];
begin
  if tg_op = 'UPDATE' then
    new.lab_id := old.lab_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    v_old_people := old.person_ids;
  end if;
  if new.experiment_id is not null and new.experiment_id is distinct from (case when tg_op = 'UPDATE' then old.experiment_id end)
    and not exists (select 1 from experiments x where x.id = new.experiment_id and x.lab_id = new.lab_id) then
    raise exception 'no such experiment' using errcode = 'BL401';
  end if;
  if new.protocol_id is not null and new.protocol_id is distinct from (case when tg_op = 'UPDATE' then old.protocol_id end) then
    if not exists (select 1 from protocols p where p.id = new.protocol_id and p.lab_id = new.lab_id) then
      raise exception 'no such protocol' using errcode = 'BL103';
    end if;
    if exists (select 1 from protocols p where p.id = new.protocol_id and p.archived_at is not null) then
      raise exception 'this protocol is archived' using errcode = 'BL102';
    end if;
  end if;
  if new.instrument_id is not null and new.instrument_id is distinct from (case when tg_op = 'UPDATE' then old.instrument_id end) then
    if not exists (select 1 from instruments i where i.id = new.instrument_id and i.lab_id = new.lab_id) then
      raise exception 'no such instrument' using errcode = 'BL401';
    end if;
    if exists (select 1 from instruments i where i.id = new.instrument_id and i.revoked_at is not null) then
      raise exception 'this instrument was removed' using errcode = 'BL402';
    end if;
  end if;
  if exists (
    select 1 from unnest(new.person_ids) as n(id)
    where n.id <> all (v_old_people)
      and not exists (select 1 from people p where p.id = n.id and p.lab_id = new.lab_id)
  ) then
    raise exception 'no such person' using errcode = 'BL401';
  end if;
  -- Once each, in the order given; people removed since the last save drop out.
  select coalesce(array_agg(n.id order by n.ord), '{}') into v_kept
  from (
    select distinct on (u.id) u.id, u.ord from unnest(new.person_ids) with ordinality as u(id, ord)
    order by u.id, u.ord
  ) n
  where exists (select 1 from people p where p.id = n.id and p.lab_id = new.lab_id);
  new.person_ids := v_kept;
  new.title := btrim(new.title);
  new.notes := nullif(btrim(coalesce(new.notes, '')), '');
  new.updated_at := clock_timestamp();
  return new;
end
$$;

create function calendar_entries_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into audit_log (lab_id, actor, action, target) values (new.lab_id, auth.uid(), 'calendar.create', new.id::text);
  elsif tg_op = 'UPDATE' then
    insert into audit_log (lab_id, actor, action, target) values (new.lab_id, auth.uid(), 'calendar.save', new.id::text);
  -- A lab being deleted takes its entries with it; that isn't someone deleting an entry.
  elsif exists (select 1 from labs where id = old.lab_id) then
    insert into audit_log (lab_id, actor, action, target) values (old.lab_id, auth.uid(), 'calendar.delete', old.id::text);
  end if;
  return null;
end
$$;

create trigger calendar_entries_before_write before insert or update on calendar_entries
  for each row execute function calendar_entries_before_write();
create trigger calendar_entries_audit after insert or update or delete on calendar_entries
  for each row execute function calendar_entries_audit();

-- One entry as the web app reads it, with the names of what it links to.
create function calendar_entry_json(e calendar_entries) returns jsonb
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
    'created_by', e.created_by,
    'created_at', e.created_at,
    'updated_at', e.updated_at
  )
$$;

-- A range is a month grid or a week, at most 62 days, in a time zone Postgres knows.
create function calendar_check_range(p_from date, p_to date, p_tz text) returns void
language plpgsql stable as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'a calendar range is up to 62 days' using errcode = '22023';
  end if;
  if p_tz is null then
    raise exception 'a calendar range needs a time zone' using errcode = '22023';
  end if;
  -- Raises 22023 for a zone Postgres doesn't know.
  perform now() at time zone p_tz;
end
$$;

-- Every file in the lab whose day falls in the range: its label date, or else the day its newest
-- live copy was modified, where the viewer is. One row per file (sha256), as search shows it.
-- Its kind follows that copy's source: an upload, an instrument's file, or a file in Dropbox.
-- Files are grouped by experiment, an instrument's files by instrument. Talk-through recordings
-- are left out: the talk-through itself is on the record.
create function calendar_files(
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
  with candidates as (
    select l.sha256 from labels l
    where l.lab_id = p_lab_id and l.date between p_from and p_to
    union
    select fl.sha256 from file_locations fl
    where fl.lab_id = p_lab_id and fl.deleted_at is null and fl.sha256 is not null
      and fl.modified_at >= v_from and fl.modified_at < v_to
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

-- What people made in the range besides files: protocol versions (grouped by protocol), charts
-- and talk-throughs, each on the day it was made where the viewer is. A person filter matches
-- what that person's membership made; an experiment filter matches through the experiment's
-- protocol (and a chart's file label); an instrument filter matches none of these.
create function calendar_events(
  p_lab_id uuid,
  p_from date,
  p_to date,
  p_tz text,
  p_experiment_id uuid default null,
  p_person_id uuid default null,
  p_instrument_id uuid default null
)
returns table (day date, kind text, group_id uuid, group_name text, target uuid, title text, at timestamptz, actor uuid)
language plpgsql stable security invoker set search_path = public as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_user uuid;
begin
  perform calendar_check_range(p_from, p_to, p_tz);
  if p_instrument_id is not null then
    return;
  end if;
  v_from := p_from::timestamp at time zone p_tz;
  v_to := (p_to + 1)::timestamp at time zone p_tz;
  if p_person_id is not null then
    select p.member_user_id into v_user from people p where p.id = p_person_id and p.lab_id = p_lab_id;
    if v_user is null then
      return;
    end if;
  end if;
  return query
  select (pv.created_at at time zone p_tz)::date, 'protocol'::text, pv.protocol_id, cur.title,
    pv.protocol_id, pv.title, pv.created_at, pv.author
  from protocol_versions pv
  join protocols p on p.id = pv.protocol_id and p.archived_at is null
  join protocol_versions cur on cur.id = p.current_version_id
  where pv.lab_id = p_lab_id and pv.created_at >= v_from and pv.created_at < v_to
    and (v_user is null or pv.author = v_user)
    and (p_experiment_id is null or exists (
      select 1 from experiments x where x.id = p_experiment_id and x.protocol_id = pv.protocol_id))
  union all
  select (c.created_at at time zone p_tz)::date, 'chart'::text, null::uuid, null::text,
    c.id, c.title, c.created_at, c.created_by
  from charts c
  where c.lab_id = p_lab_id and c.created_at >= v_from and c.created_at < v_to
    and (v_user is null or c.created_by = v_user)
    and (p_experiment_id is null
      or exists (select 1 from experiments x where x.id = p_experiment_id and x.protocol_id = c.protocol_id)
      or exists (select 1 from labels l where l.lab_id = p_lab_id and l.sha256 = c.sha256 and l.experiment_id = p_experiment_id))
  union all
  select (t.recorded_at at time zone p_tz)::date, 'talk_through'::text, null::uuid, null::text,
    t.id,
    coalesce(
      (select v.title from protocols p join protocol_versions v on v.id = p.current_version_id where p.id = t.protocol_id),
      case when t.kind = 'tutorial' then 'New tutorial' else 'New protocol' end
    ),
    t.recorded_at, t.recorded_by
  from talk_throughs t
  where t.lab_id = p_lab_id and t.recorded_at >= v_from and t.recorded_at < v_to
    and (v_user is null or t.recorded_by = v_user)
    and (p_experiment_id is null or exists (
      select 1 from experiments x where x.id = p_experiment_id and x.protocol_id = t.protocol_id));
end
$$;

-- The record for a month grid or a week: per day, kind and group, how many and, for one, its
-- name. Members only.
create function calendar_record(
  p_lab_id uuid,
  p_from date,
  p_to date,
  p_tz text,
  p_experiment_id uuid default null,
  p_person_id uuid default null,
  p_instrument_id uuid default null
)
returns table (day date, kind text, group_id uuid, group_name text, items bigint, title text)
language plpgsql stable security invoker set search_path = public as $$
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  return query
  select r.day, r.kind, r.group_id, r.group_name, r.items, r.title
  from (
    select f.day, f.kind, f.group_id, f.group_name, count(*) as items,
      case when count(*) = 1 then min(f.name) end as title
    from calendar_files(p_lab_id, p_from, p_to, p_tz, p_experiment_id, p_person_id, p_instrument_id) f
    group by f.day, f.kind, f.group_id, f.group_name
    union all
    select e.day, e.kind, e.group_id, e.group_name, count(*),
      case when count(*) = 1 then min(e.title) end
    from calendar_events(p_lab_id, p_from, p_to, p_tz, p_experiment_id, p_person_id, p_instrument_id) e
    group by e.day, e.kind, e.group_id, e.group_name
  ) r
  order by r.day,
    array_position(array['file', 'upload', 'instrument', 'protocol', 'chart', 'talk_through'], r.kind),
    r.items desc, r.group_name nulls last;
end
$$;

-- Plans in a range, with the same filters. A person filter matches the people on an entry.
create function calendar_plans(
  p_lab_id uuid,
  p_from date,
  p_to date,
  p_tz text,
  p_experiment_id uuid default null,
  p_person_id uuid default null,
  p_instrument_id uuid default null
)
returns setof jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_from timestamptz;
  v_to timestamptz;
begin
  perform calendar_check_range(p_from, p_to, p_tz);
  v_from := p_from::timestamp at time zone p_tz;
  v_to := (p_to + 1)::timestamp at time zone p_tz;
  return query
  select calendar_entry_json(e)
  from calendar_entries e
  where e.lab_id = p_lab_id
    and ((e.starts_on <= p_to and e.ends_on >= p_from) or (e.starts_at < v_to and e.ends_at > v_from))
    and (p_experiment_id is null or e.experiment_id = p_experiment_id)
    and (p_person_id is null or p_person_id = any (e.person_ids))
    and (p_instrument_id is null or e.instrument_id = p_instrument_id)
  order by coalesce(e.starts_at, e.starts_on::timestamp at time zone p_tz), e.created_at, e.id;
end
$$;

create function calendar_entry(p_entry_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select calendar_entry_json(e) from calendar_entries e where e.id = p_entry_id
$$;

-- A protocol's coming entries, soonest first. The server doesn't know the reader's day, so an
-- all-day entry that ended yesterday in UTC is kept and the page drops it on the reader's side.
create function calendar_upcoming(p_lab_id uuid, p_protocol_id uuid, p_limit int default 5)
returns setof jsonb
language sql stable security invoker set search_path = public as $$
  select calendar_entry_json(e)
  from calendar_entries e
  where e.lab_id = p_lab_id and e.protocol_id = p_protocol_id
    and (e.ends_on >= (now() at time zone 'UTC')::date - 1 or e.ends_at > now())
  order by coalesce(e.starts_at, e.starts_on::timestamp at time zone 'UTC'), e.id
  limit least(greatest(p_limit, 1), 20) + 1
$$;

-- Other entries booking the same instrument at an overlapping time, for the editor's notice. An
-- all-day entry holds its days from midnight to midnight where the viewer is.
create function calendar_overlaps(
  p_lab_id uuid,
  p_instrument_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_tz text,
  p_except uuid default null
)
returns setof jsonb
language plpgsql stable security invoker set search_path = public as $$
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'an overlap check needs a start before its end' using errcode = '22023';
  end if;
  perform calendar_check_range(current_date, current_date, p_tz);
  return query
  select calendar_entry_json(e)
  from calendar_entries e
  where e.lab_id = p_lab_id and e.instrument_id = p_instrument_id
    and e.id is distinct from p_except
    and coalesce(e.starts_at, e.starts_on::timestamp at time zone p_tz) < p_to
    and coalesce(e.ends_at, (e.ends_on + 1)::timestamp at time zone p_tz) > p_from
  order by coalesce(e.starts_at, e.starts_on::timestamp at time zone p_tz), e.id
  limit 5;
end
$$;

revoke all on calendar_entries from anon, authenticated;
revoke all on function
  calendar_entry_json(calendar_entries), calendar_check_range(date, date, text),
  calendar_files(uuid, date, date, text, uuid, uuid, uuid), calendar_events(uuid, date, date, text, uuid, uuid, uuid),
  calendar_record(uuid, date, date, text, uuid, uuid, uuid), calendar_plans(uuid, date, date, text, uuid, uuid, uuid),
  calendar_entry(uuid), calendar_upcoming(uuid, uuid, int),
  calendar_overlaps(uuid, uuid, timestamptz, timestamptz, text, uuid)
from public, anon, authenticated;
grant select, delete on calendar_entries to authenticated;
grant insert (lab_id, title, notes, starts_on, ends_on, starts_at, ends_at, experiment_id, protocol_id, instrument_id, person_ids)
  on calendar_entries to authenticated;
grant update (title, notes, starts_on, ends_on, starts_at, ends_at, experiment_id, protocol_id, instrument_id, person_ids)
  on calendar_entries to authenticated;
grant execute on function
  calendar_entry_json(calendar_entries), calendar_check_range(date, date, text),
  calendar_files(uuid, date, date, text, uuid, uuid, uuid), calendar_events(uuid, date, date, text, uuid, uuid, uuid),
  calendar_record(uuid, date, date, text, uuid, uuid, uuid), calendar_plans(uuid, date, date, text, uuid, uuid, uuid),
  calendar_entry(uuid), calendar_upcoming(uuid, uuid, int),
  calendar_overlaps(uuid, uuid, timestamptz, timestamptz, text, uuid)
to authenticated;
