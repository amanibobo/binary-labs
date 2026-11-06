-- Checking results (decisions.md, "checking results: expected values and flags"). A protocol
-- version's expected_values holds its checks; the worker evaluates them against a file's parsed
-- table whenever the file, its label or the protocol changes, keeps one check_results row per
-- file and check, and raises a flag for each check that fails. A flag can't exist without the
-- protocol version that held the rule, the file it was read from and the exact cells read.

-- A new enum value can't be used in the transaction that adds it. Only plpgsql bodies,
-- which aren't checked until they run, name these.
alter type audit_action add value if not exists 'check.save';
alter type audit_action add value if not exists 'flag.review';

create type check_kind as enum ('curve_fit', 'peak', 'value', 'control');
create type check_outcome as enum ('passed', 'flagged', 'couldnt');
create type flag_review as enum ('useful', 'wrong', 'known_issue');

-- The allowed range of a check, mirroring CheckRange in apps/web/src/lib/checks.ts.
create function check_range_ok(r jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(r) = 'object'
    and not exists (
      select 1 from jsonb_each(r) e
      where e.key <> 'kind' and not (jsonb_typeof(e.value) = 'number' and abs((e.value #>> '{}')::numeric) < 1e15)
    )
    and case r ->> 'kind'
      when 'at_least' then (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['kind', 'min']
      when 'at_most' then (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['kind', 'max']
      when 'between' then (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['kind', 'max', 'min']
        and (r ->> 'min')::float8 <= (r ->> 'max')::float8
      when 'around' then (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['kind', 'target', 'tolerance']
        and (r ->> 'tolerance')::float8 >= 0
      else false
    end,
    false
  )
$$;

-- Whether a value is inside a range; bl_worker/checks.py's `holds` computes the same.
create function range_holds(r jsonb, v float8) returns boolean
language sql immutable parallel safe as $$
  select case r ->> 'kind'
    when 'at_least' then v >= (r ->> 'min')::float8
    when 'at_most' then v <= (r ->> 'max')::float8
    when 'between' then v >= (r ->> 'min')::float8 and v <= (r ->> 'max')::float8
    when 'around' then abs(v - (r ->> 'target')::float8) <= (r ->> 'tolerance')::float8
  end
$$;

-- A column named in a check: its name as the file writes it, "name (unit)", or its letter.
create function check_column_ok(v jsonb, nullable boolean) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    case jsonb_typeof(v)
      when 'null' then nullable
      when 'string' then length(btrim(v #>> '{}')) between 1 and 120
      else false
    end,
    false
  )
$$;

create function check_text_ok(v jsonb, max_length int) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and length(btrim(v #>> '{}')) between 1 and max_length),
    false
  )
$$;

-- One check, mirroring CheckSpec in apps/web/src/lib/checks.ts. Every key is required, with
-- null for "work it out" or "none".
create function check_spec_ok(c jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(c) = 'object'
    and (c ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(c -> 'name') = 'string'
    and length(btrim(c ->> 'name')) between 1 and 80
    and check_text_ok(c -> 'sheet', 200)
    and check_text_ok(c -> 'unit', 40)
    and check_range_ok(c -> 'range')
    and case c ->> 'kind'
      when 'curve_fit' then check_column_ok(c -> 'x', true) and check_column_ok(c -> 'y', true)
      when 'peak' then check_column_ok(c -> 'x', true) and check_column_ok(c -> 'y', true)
      when 'value' then check_column_ok(c -> 'column', false)
        and c ->> 'stat' in ('mean', 'max', 'min', 'cell')
        and check_text_ok(c -> 'row', 120)
        and ((c ->> 'stat' = 'cell') = (jsonb_typeof(c -> 'row') = 'string'))
      when 'control' then jsonb_typeof(c -> 'pattern') = 'string'
        and length(btrim(c ->> 'pattern')) between 1 and 80
        and check_column_ok(c -> 'labelColumn', true)
        and check_column_ok(c -> 'column', false)
        and c ->> 'use' in ('each', 'mean')
      else false
    end,
    false
  )
$$;

create function expected_values_ok(v jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(v) = 'array'
    and jsonb_array_length(v) <= 40
    and length(v::text) <= 40000
    and not exists (select 1 from jsonb_array_elements(v) e where not check_spec_ok(e))
    and (select count(distinct e ->> 'id') from jsonb_array_elements(v) e) = jsonb_array_length(v),
    false
  )
$$;

alter table protocol_versions add constraint protocol_versions_expected_values_ok
  check (expected_values_ok(expected_values));

-- Columns by spreadsheet letter and rows by their place in the parsed table (0-based), as the
-- worker read them.
create function source_columns_ok(c text[]) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    array_ndims(c) = 1 and cardinality(c) between 1 and 64
    and not exists (select 1 from unnest(c) x where x is null or x !~ '^[A-Z]{1,3}$'),
    false
  )
$$;

create function source_rows_ok(r int4multirange) returns boolean
language sql immutable parallel safe as $$
  select coalesce(not isempty(r) and lower(r) >= 0 and upper(r) <= 10000000, false)
$$;

-- Which files want checking. Triggers below put a file here when its table is ready, its label
-- moves, or a protocol it's tied to changes; the worker checks each one whose request is newer
-- than its last check. Written only by triggers and the worker.
create table check_requests (
  lab_id uuid not null,
  sha256 text not null,
  requested_at timestamptz not null default clock_timestamp(),
  checked_at timestamptz,
  primary key (lab_id, sha256),
  foreign key (lab_id, sha256) references data_tables (lab_id, sha256) on delete cascade
);
create index check_requests_due_idx on check_requests (requested_at);

-- The latest outcome of every check that applies to a file: passed, flagged, or couldn't be
-- computed and why. Written only by the worker.
create table check_results (
  lab_id uuid not null,
  sha256 text not null,
  protocol_id uuid not null,
  protocol_version_id uuid not null,
  check_id uuid not null,
  kind check_kind not null,
  outcome check_outcome not null,
  observed float8,
  unit text check (unit is null or length(unit) <= 40),
  reason text check (reason is null or length(btrim(reason)) between 1 and 300),
  checked_at timestamptz not null default now(),
  primary key (lab_id, sha256, protocol_id, check_id),
  foreign key (lab_id, sha256) references data_tables (lab_id, sha256) on delete cascade,
  foreign key (protocol_id, lab_id) references protocols (id, lab_id) on delete cascade,
  foreign key (protocol_version_id, protocol_id) references protocol_versions (id, protocol_id) on delete cascade,
  check ((outcome = 'couldnt') = (reason is not null)),
  check (outcome = 'couldnt' or observed is not null)
);
create index check_results_protocol_idx on check_results (protocol_id);

-- A failed check. The worker raises it and clears it when a later check of the same file
-- passes, can't be computed or no longer applies; people answer it. Every column that says
-- where the value came from is required, and the triggers check the rule against the version.
create table flags (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  sha256 text not null,
  protocol_id uuid not null,
  protocol_version_id uuid not null,
  check_id uuid not null,
  kind check_kind not null,
  observed float8 not null check (observed = observed and abs(observed) < 'infinity'),
  expected jsonb not null check (check_range_ok(expected)),
  unit text check (unit is null or length(unit) <= 40),
  -- Where the value was read: the file's table, the columns by letter, the rows by index.
  source_sheet text not null check (length(source_sheet) between 1 and 200),
  source_columns text[] not null check (source_columns_ok(source_columns)),
  source_rows int4multirange not null check (source_rows_ok(source_rows)),
  -- For a control check: the file and rows the day's controls were read from (it may be this file).
  control_sha256 text,
  control_sheet text check (control_sheet is null or length(control_sheet) between 1 and 200),
  control_columns text[] check (control_columns is null or source_columns_ok(control_columns)),
  control_rows int4multirange check (control_rows is null or source_rows_ok(control_rows)),
  -- A digest of the rule, the value and the cells, so checking again keeps a flag that hasn't changed.
  evidence text not null check (evidence ~ '^[0-9a-f]{64}$'),
  raised_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_reason text check (cleared_reason is null or length(cleared_reason) between 1 and 200),
  review flag_review,
  review_note text check (review_note is null or length(btrim(review_note)) between 1 and 500),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  foreign key (lab_id, sha256) references data_tables (lab_id, sha256) on delete cascade,
  foreign key (lab_id, control_sha256) references data_tables (lab_id, sha256) on delete cascade,
  foreign key (protocol_id, lab_id) references protocols (id, lab_id) on delete cascade,
  foreign key (protocol_version_id, protocol_id) references protocol_versions (id, protocol_id) on delete cascade,
  -- A flag is a value outside its range, never one inside it.
  check (not range_holds(expected, observed)),
  check ((cleared_at is null) = (cleared_reason is null)),
  check (
    (control_sha256 is null) = (control_sheet is null)
    and (control_sheet is null) = (control_columns is null)
    and (control_columns is null) = (control_rows is null)
  ),
  check ((kind = 'control') = (control_sha256 is not null)),
  check ((review is null) = (reviewed_at is null)),
  check (review is not null or review_note is null)
);
-- One open flag per file and check.
create unique index flags_open_idx on flags (lab_id, sha256, protocol_id, check_id) where cleared_at is null;
create index flags_lab_idx on flags (lab_id, raised_at desc) where cleared_at is null;
create index flags_protocol_idx on flags (protocol_id);
create index flags_control_idx on flags (lab_id, control_sha256) where control_sha256 is not null;

alter table check_requests enable row level security;
alter table check_results enable row level security;
alter table flags enable row level security;

create policy check_requests_select on check_requests for select using (is_lab_member(lab_id));
create policy check_results_select on check_results for select using (is_lab_member(lab_id));
create policy flags_select on flags for select using (is_lab_member(lab_id));
create policy flags_update on flags for update using (is_lab_member(lab_id)) with check (is_lab_member(lab_id));

-- A flag cites a check its protocol version holds, with that version's range and kind.
create function flags_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- A missing version is the not-null constraint's to refuse.
  if new.protocol_version_id is not null and not exists (
    select 1 from protocol_versions v cross join jsonb_array_elements(v.expected_values) e
    where v.id = new.protocol_version_id and v.protocol_id = new.protocol_id and v.lab_id = new.lab_id
      and e ->> 'id' = new.check_id::text and e ->> 'kind' = new.kind::text and e -> 'range' = new.expected
  ) then
    raise exception 'a flag cites a check its protocol version holds' using errcode = '23514';
  end if;
  return new;
end
$$;

-- People answer a flag; nothing else about it changes for them (column grants), and the answer
-- carries who gave it and when.
create function flags_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.review is distinct from old.review or new.review_note is distinct from old.review_note then
    if new.review is null then
      raise exception 'an answer can be changed, not taken back' using errcode = '22023';
    end if;
    new.review_note := nullif(btrim(new.review_note), '');
    new.reviewed_by := auth.uid();
    new.reviewed_at := now();
  end if;
  return new;
end
$$;

create function flags_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.review is distinct from old.review or new.review_note is distinct from old.review_note then
    insert into audit_log (lab_id, actor, action, target)
    values (new.lab_id, auth.uid(), 'flag.review', new.id::text || ' ' || new.review::text);
  end if;
  return null;
end
$$;

create trigger flags_before_insert before insert on flags
  for each row execute function flags_before_insert();
create trigger flags_before_update before update on flags
  for each row execute function flags_before_update();
create trigger flags_audit after update on flags
  for each row execute function flags_audit();

-- BL107: no such flag (or not yours to see).
create function review_flag(p_flag_id uuid, p_review flag_review, p_note text default null)
returns table (id uuid, review flag_review, review_note text, reviewed_by uuid, reviewed_at timestamptz)
language plpgsql security invoker set search_path = public as $$
begin
  if p_review is null then
    raise exception 'an answer is useful, wrong or known issue' using errcode = '22023';
  end if;
  return query
    update flags f set review = p_review, review_note = p_note
    where f.id = p_flag_id
    returning f.id, f.review, f.review_note, f.reviewed_by, f.reviewed_at;
  if not found then
    raise exception 'no such flag' using errcode = 'BL107';
  end if;
end
$$;

-- A save that doesn't touch the checks keeps the ones it started from; only save_checks sets
-- them (members can't write the column). Tutorials never carry checks.
create function protocol_versions_carry_checks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.based_on is not null and coalesce(current_setting('bl.saving_checks', true), '') <> 'on' then
    select v.expected_values into new.expected_values from protocol_versions v where v.id = new.based_on;
  end if;
  if new.expected_values <> '[]'::jsonb
    and exists (select 1 from protocols p where p.id = new.protocol_id and p.kind = 'tutorial') then
    raise exception 'a tutorial has no checks' using errcode = 'BL108';
  end if;
  return new;
end
$$;

-- Runs after protocol_versions_before_insert (triggers fire by name), which numbers the version
-- and refuses a stale base.
create trigger protocol_versions_carry_checks before insert on protocol_versions
  for each row execute function protocol_versions_carry_checks();

-- Saves a new version with these checks on top of p_base_version_id, keeping its title and
-- body. Raises the protocol codes (BL101 someone saved since, BL102 archived, BL103 no such
-- page) and BL108 for a tutorial.
create function save_checks(p_protocol_id uuid, p_base_version_id uuid, p_checks jsonb, p_note text default null)
returns table (protocol_id uuid, version_id uuid, version int)
language plpgsql security definer set search_path = public as $$
declare
  v_lab uuid;
  v_base protocol_versions;
  v_id uuid;
  v_number int;
begin
  select p.lab_id into v_lab from protocols p where p.id = p_protocol_id;
  if not found or auth.uid() is null or not is_lab_member(v_lab) then
    raise exception 'no such protocol' using errcode = 'BL103';
  end if;
  select * into v_base from protocol_versions v where v.id = p_base_version_id and v.protocol_id = p_protocol_id;
  if not found then
    raise exception 'a save names the version it started from' using errcode = '22023';
  end if;
  perform set_config('bl.saving_checks', 'on', true);
  insert into protocol_versions (protocol_id, lab_id, based_on, title, body, note, expected_values, author)
  values (p_protocol_id, v_lab, p_base_version_id, v_base.title, v_base.body, p_note, coalesce(p_checks, '[]'), auth.uid())
  returning protocol_versions.id, protocol_versions.version into v_id, v_number;
  perform set_config('bl.saving_checks', '', true);
  insert into audit_log (lab_id, actor, action, target)
  values (v_lab, auth.uid(), 'check.save', p_protocol_id::text || ' v' || v_number);
  return query select p_protocol_id, v_id, v_number;
end
$$;

-- Asking the worker to check files again --------------------------------------------------

create function request_checks(p_lab_id uuid, p_shas text[]) returns void
language sql security definer set search_path = public as $$
  insert into check_requests (lab_id, sha256)
  select t.lab_id, t.sha256 from data_tables t
  join labs l on l.id = t.lab_id and l.deletion_requested_at is null
  where t.lab_id = p_lab_id and t.sha256 = any (p_shas) and t.state = 'ready'
  on conflict (lab_id, sha256) do update set requested_at = clock_timestamp()
$$;

-- The files labeled with one experiment on one day: whose controls a control check may read.
create function same_day_files(p_lab_id uuid, p_experiment_id uuid, p_date date) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(l.sha256), '{}')
  from labels l
  where p_experiment_id is not null and p_date is not null
    and l.lab_id = p_lab_id and l.experiment_id = p_experiment_id and l.date = p_date
    and l.status <> 'needs_look'
$$;

-- Every file a protocol's checks reach now or reached at its last check.
create function protocol_check_files(p_protocol_id uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct s.sha256), '{}') from (
    select l.sha256 from labels l join experiments e on e.id = l.experiment_id and e.lab_id = l.lab_id
    where e.protocol_id = p_protocol_id and l.status <> 'needs_look'
    union all select f.sha256 from protocol_files f where f.protocol_id = p_protocol_id
    union all select r.sha256 from check_results r where r.protocol_id = p_protocol_id
    union all select g.sha256 from flags g where g.protocol_id = p_protocol_id and g.cleared_at is null
  ) s
$$;

create function data_tables_request_checks() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  l labels;
begin
  select * into l from labels where lab_id = new.lab_id and sha256 = new.sha256;
  perform request_checks(new.lab_id, array[new.sha256] || same_day_files(new.lab_id, l.experiment_id, l.date));
  return null;
end
$$;

create trigger data_tables_request_checks after insert or update of state, storage_key on data_tables
  for each row when (new.state = 'ready') execute function data_tables_request_checks();

create function labels_request_checks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform request_checks(
    new.lab_id,
    array[new.sha256]
      || same_day_files(new.lab_id, new.experiment_id, new.date)
      || (case when tg_op = 'UPDATE' then same_day_files(old.lab_id, old.experiment_id, old.date) else '{}'::text[] end)
  );
  return null;
end
$$;

create trigger labels_request_checks_insert after insert on labels
  for each row execute function labels_request_checks();
create trigger labels_request_checks_update after update of experiment_id, date, status on labels
  for each row
  when (
    new.experiment_id is distinct from old.experiment_id or new.date is distinct from old.date
    or (new.status = 'needs_look') is distinct from (old.status = 'needs_look')
  )
  execute function labels_request_checks();

create function protocols_request_checks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform request_checks(new.lab_id, protocol_check_files(new.id));
  return null;
end
$$;

create trigger protocols_request_checks after update of current_version_id, archived_at on protocols
  for each row
  when (new.current_version_id is distinct from old.current_version_id or new.archived_at is distinct from old.archived_at)
  execute function protocols_request_checks();

create function experiments_request_checks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform request_checks(
    new.lab_id,
    (select coalesce(array_agg(l.sha256), '{}') from labels l where l.lab_id = new.lab_id and l.experiment_id = new.id)
      || (case when old.protocol_id is null then '{}'::text[] else protocol_check_files(old.protocol_id) end)
  );
  return null;
end
$$;

create trigger experiments_request_checks after update of protocol_id on experiments
  for each row when (new.protocol_id is distinct from old.protocol_id)
  execute function experiments_request_checks();

create function protocol_files_request_checks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform request_checks(new.lab_id, array[new.sha256]);
  else
    perform request_checks(old.lab_id, array[old.sha256]);
  end if;
  return null;
end
$$;

create trigger protocol_files_request_checks after insert or delete on protocol_files
  for each row execute function protocol_files_request_checks();

-- Reading results ----------------------------------------------------------------------------

-- Rows of a multirange as [first, last] pairs, for the browser.
create function row_spans(r int4multirange) returns jsonb
language sql immutable parallel safe as $$
  select coalesce(jsonb_agg(jsonb_build_array(lower(s), upper(s) - 1) order by lower(s)), '[]'::jsonb)
  from unnest(r) s
$$;

-- The newest live place a file lives, shaped like search's locations, and its clean name;
-- null once the file is gone from the lab.
create function flag_file_json(p_lab_id uuid, p_sha256 text) returns jsonb
language sql stable security invoker set search_path = public as $$
  select case when l.loc is null then null else jsonb_build_object(
    'location', l.loc,
    'cleanName', (select lb.clean_name from labels lb where lb.lab_id = p_lab_id and lb.sha256 = p_sha256)
  ) end
  from (select live_locations_json(p_lab_id, p_sha256) -> 0 as loc) l
$$;

-- A lab's flags with what a reader needs beside them: the cited version's title and number, the
-- check's name, and a live place each file lives (null once the file is gone).
create function lab_flags(p_lab_id uuid)
returns table (
  id uuid,
  sha256 text,
  protocol_id uuid,
  protocol_title text,
  protocol_version int,
  protocol_version_id uuid,
  check_id uuid,
  check_name text,
  kind check_kind,
  observed float8,
  expected jsonb,
  unit text,
  source_sheet text,
  source_columns text[],
  source_rows jsonb,
  control_sha256 text,
  control_sheet text,
  control_columns text[],
  control_rows jsonb,
  raised_at timestamptz,
  cleared_at timestamptz,
  cleared_reason text,
  review flag_review,
  review_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  file jsonb,
  control_file jsonb
)
language sql stable security invoker set search_path = public as $$
  select f.id, f.sha256, f.protocol_id, v.title, v.version, v.id, f.check_id,
    (select e ->> 'name' from jsonb_array_elements(v.expected_values) e where e ->> 'id' = f.check_id::text limit 1),
    f.kind, f.observed, f.expected, f.unit, f.source_sheet, f.source_columns, row_spans(f.source_rows),
    f.control_sha256, f.control_sheet, f.control_columns,
    case when f.control_rows is null then null else row_spans(f.control_rows) end,
    f.raised_at, f.cleared_at, f.cleared_reason, f.review, f.review_note, f.reviewed_by, f.reviewed_at,
    flag_file_json(f.lab_id, f.sha256),
    case when f.control_sha256 is null then null else flag_file_json(f.lab_id, f.control_sha256) end
  from flags f
  join protocol_versions v on v.id = f.protocol_version_id
  where f.lab_id = p_lab_id
$$;

-- Open flags nobody has answered: the count beside Flags in the sidebar.
create function flag_queue_count(p_lab_id uuid) returns int
language sql stable security invoker set search_path = public as $$
  select count(*)::int from flags f where f.lab_id = p_lab_id and f.cleared_at is null and f.review is null
$$;

-- Open flags per file, leaving out ones answered "wrong": what marks a file's row amber.
create function file_flag_marks(p_lab_id uuid, p_shas text[])
returns table (sha256 text, flags int)
language sql stable security invoker set search_path = public as $$
  select f.sha256, count(*)::int from flags f
  where f.lab_id = p_lab_id and f.sha256 = any (p_shas) and f.cleared_at is null
    and f.review is distinct from 'wrong'
  group by f.sha256
$$;

-- Every check that applies to a file and how it came out, in the protocol's order.
create function file_checks(p_lab_id uuid, p_sha256 text)
returns table (
  protocol_id uuid,
  protocol_title text,
  protocol_version int,
  check_id uuid,
  check_name text,
  kind check_kind,
  outcome check_outcome,
  observed float8,
  expected jsonb,
  unit text,
  reason text,
  flag_id uuid,
  checked_at timestamptz
)
language sql stable security invoker set search_path = public as $$
  select r.protocol_id, v.title, v.version, r.check_id, c.spec ->> 'name', r.kind, r.outcome, r.observed,
    c.spec -> 'range', r.unit, r.reason,
    (select f.id from flags f
      where f.lab_id = r.lab_id and f.sha256 = r.sha256 and f.protocol_id = r.protocol_id
        and f.check_id = r.check_id and f.cleared_at is null),
    r.checked_at
  from check_results r
  join protocol_versions v on v.id = r.protocol_version_id
  cross join lateral (
    select e as spec, n from jsonb_array_elements(v.expected_values) with ordinality as x(e, n)
    where e ->> 'id' = r.check_id::text limit 1
  ) c
  where r.lab_id = p_lab_id and r.sha256 = p_sha256
  order by lower(v.title), r.protocol_id, c.n
$$;

-- How each check's flags were answered, for admins tuning the checks.
create function check_usefulness(p_lab_id uuid)
returns table (protocol_id uuid, check_id uuid, flags int, useful int, wrong int, known_issue int)
language plpgsql stable security invoker set search_path = public as $$
begin
  if not is_lab_admin(p_lab_id) then
    raise exception 'only admins see how flags were answered' using errcode = '42501';
  end if;
  return query
    select f.protocol_id, f.check_id, count(*)::int,
      (count(*) filter (where f.review = 'useful'))::int,
      (count(*) filter (where f.review = 'wrong'))::int,
      (count(*) filter (where f.review = 'known_issue'))::int
    from flags f
    where f.lab_id = p_lab_id
    group by f.protocol_id, f.check_id;
end
$$;

revoke all on check_requests, check_results, flags from anon, authenticated;
revoke all on function
  check_range_ok(jsonb), range_holds(jsonb, float8), check_column_ok(jsonb, boolean), check_text_ok(jsonb, int),
  check_spec_ok(jsonb), expected_values_ok(jsonb), source_columns_ok(text[]), source_rows_ok(int4multirange),
  flags_before_insert(), flags_before_update(), flags_audit(), review_flag(uuid, flag_review, text),
  protocol_versions_carry_checks(), save_checks(uuid, uuid, jsonb, text),
  request_checks(uuid, text[]), same_day_files(uuid, uuid, date), protocol_check_files(uuid),
  data_tables_request_checks(), labels_request_checks(), protocols_request_checks(),
  experiments_request_checks(), protocol_files_request_checks(),
  row_spans(int4multirange), flag_file_json(uuid, text), lab_flags(uuid), flag_queue_count(uuid),
  file_flag_marks(uuid, text[]),
  file_checks(uuid, text), check_usefulness(uuid)
from public, anon, authenticated;

grant select on check_requests, check_results, flags to authenticated;
grant update (review, review_note) on flags to authenticated;
grant execute on function
  check_range_ok(jsonb), range_holds(jsonb, float8), check_column_ok(jsonb, boolean), check_text_ok(jsonb, int),
  check_spec_ok(jsonb), expected_values_ok(jsonb), source_columns_ok(text[]), source_rows_ok(int4multirange),
  review_flag(uuid, flag_review, text), save_checks(uuid, uuid, jsonb, text),
  row_spans(int4multirange), flag_file_json(uuid, text), lab_flags(uuid), flag_queue_count(uuid),
  file_flag_marks(uuid, text[]),
  file_checks(uuid, text), check_usefulness(uuid)
to authenticated;
