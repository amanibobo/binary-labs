-- Charts from a lab's data sheets (decisions.md, "data sheet to chart"). The worker parses a
-- spreadsheet's full tables into JSON in the object store at <lab_id>/tables/<sha256>.json and
-- records it in data_tables. A chart names a file by its content, one of the file's tables, and
-- a spec of what to draw; it never changes the file.

alter type audit_action add value if not exists 'chart.create';
alter type audit_action add value if not exists 'chart.save';
alter type audit_action add value if not exists 'chart.delete';

-- "waiting" for the worker; "failed" when the bytes couldn't be read or parsed (a request puts
-- it back to waiting). A ready table with no tables in it is still ready: the file has none.
create type data_table_state as enum ('waiting', 'ready', 'failed');

-- Written by the worker, except that a member may ask for a table (request_data_table).
create table data_tables (
  lab_id uuid not null references labs (id) on delete cascade,
  sha256 text not null references blobs (sha256),
  state data_table_state not null default 'waiting',
  parser_version int,
  storage_key text check (storage_key is null or storage_key like lab_id::text || '/tables/%'),
  error text check (error is null or length(error) <= 500),
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (lab_id, sha256),
  check ((state = 'ready') = (storage_key is not null)),
  check ((state = 'failed') = (error is not null)),
  check (state = 'waiting' or parser_version is not null)
);
create index data_tables_waiting_idx on data_tables (requested_at) where state = 'waiting';
create index data_tables_sha_idx on data_tables (sha256);

alter table data_tables enable row level security;
create policy data_tables_select on data_tables for select using (is_lab_member(lab_id));

-- Asks the worker for a file's table: for a spreadsheet indexed before charts existed, or one
-- whose table failed. Returns the state the row is in now.
create function request_data_table(p_lab_id uuid, p_sha256 text) returns data_table_state
language plpgsql security definer set search_path = public as $$
declare
  v_state data_table_state;
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  if not exists (
    select 1 from file_locations fl join blobs b on b.sha256 = fl.sha256
    where fl.lab_id = p_lab_id and fl.sha256 = p_sha256 and fl.deleted_at is null
      and b.file_kind = 'spreadsheet'
  ) then
    raise exception 'no such data sheet in this lab' using errcode = 'BL104';
  end if;
  insert into data_tables (lab_id, sha256) values (p_lab_id, p_sha256)
  on conflict (lab_id, sha256) do update
    set state = 'waiting', error = null, requested_at = now(), updated_at = now()
    where data_tables.state = 'failed'
  returning state into v_state;
  if v_state is null then
    select t.state into v_state from data_tables t where t.lab_id = p_lab_id and t.sha256 = p_sha256;
  end if;
  return v_state;
end
$$;

-- The structure of a chart spec, mirroring ChartSpec in apps/web/src/lib/charts.ts. The web app
-- also checks the columns against the file's table, which lives in the object store. Colors are
-- palette slots, not hex, so each theme draws its own step of the same hue.
create function chart_spec_ok(s jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(s) = 'object'
    and length(s::text) <= 8000
    and s ->> 'version' = '1'
    and s ->> 'type' in ('line', 'scatter', 'bar')
    and s ->> 'legend' in ('top', 'right', 'bottom')
    and jsonb_typeof(s -> 'x') = 'object'
    and (s -> 'x' ->> 'column') ~ '^[A-Z]{1,3}$'
    and jsonb_typeof(s -> 'y') = 'object'
    and s -> 'y' ->> 'scale' in ('linear', 'log')
    and not (s ->> 'type' = 'bar' and s -> 'y' ->> 'scale' = 'log')
    and jsonb_typeof(s -> 'series') = 'array'
    and jsonb_array_length(s -> 'series') between 1 and (case when s ->> 'type' = 'scatter' then 3 else 6 end)
    and not exists (
      select 1 from jsonb_array_elements(s -> 'series') e
      where not coalesce(
        jsonb_typeof(e) = 'object'
        and (e ->> 'column') ~ '^[A-Z]{1,3}$'
        and length(btrim(e ->> 'name')) between 1 and 80
        and e ->> 'color' in ('blue', 'orange', 'aqua', 'violet', 'magenta', 'green')
        and (jsonb_typeof(e -> 'error') = 'null' or (e ->> 'error') ~ '^[A-Z]{1,3}$'),
        false
      )
    ),
    false
  )
$$;

create table charts (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  sha256 text not null references blobs (sha256),
  -- The table's name in the file: the sheet, or "Table 1" for a CSV.
  sheet text not null check (length(sheet) between 1 and 200),
  title text not null check (length(btrim(title)) between 1 and 200),
  spec jsonb not null check (chart_spec_ok(spec)),
  protocol_id uuid,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (protocol_id, lab_id) references protocols (id, lab_id) on delete set null (protocol_id)
);
create index charts_file_idx on charts (lab_id, sha256);
create index charts_protocol_idx on charts (protocol_id) where protocol_id is not null;
create index charts_sha_idx on charts (sha256);

alter table charts enable row level security;
create policy charts_select on charts for select using (is_lab_member(lab_id));
create policy charts_insert on charts for insert
  with check (is_lab_member(lab_id) and created_by = auth.uid());
create policy charts_update on charts for update
  using (is_lab_member(lab_id)) with check (is_lab_member(lab_id));
create policy charts_delete on charts for delete using (is_lab_member(lab_id));

-- A chart stays on the file and lab it was made from; BL104 is a file the lab doesn't hold,
-- BL102 an archived protocol, BL103 a protocol that isn't this lab's.
create function charts_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.lab_id := old.lab_id;
    new.sha256 := old.sha256;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  elsif not exists (
    select 1 from file_locations fl
    where fl.lab_id = new.lab_id and fl.sha256 = new.sha256 and fl.deleted_at is null
  ) then
    raise exception 'no such file in this lab' using errcode = 'BL104';
  end if;
  if new.protocol_id is not null and new.protocol_id is distinct from (case when tg_op = 'UPDATE' then old.protocol_id end) then
    if not exists (select 1 from protocols p where p.id = new.protocol_id and p.lab_id = new.lab_id) then
      raise exception 'no such protocol' using errcode = 'BL103';
    end if;
    if exists (select 1 from protocols p where p.id = new.protocol_id and p.archived_at is not null) then
      raise exception 'this page is archived' using errcode = 'BL102';
    end if;
  end if;
  new.title := btrim(new.title);
  new.updated_at := clock_timestamp();
  return new;
end
$$;

create function charts_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into audit_log (lab_id, actor, action, target) values (new.lab_id, auth.uid(), 'chart.create', new.id::text);
  elsif tg_op = 'UPDATE' then
    insert into audit_log (lab_id, actor, action, target) values (new.lab_id, auth.uid(), 'chart.save', new.id::text);
  -- A lab being deleted takes its charts with it; that isn't someone deleting a chart.
  elsif exists (select 1 from labs where id = old.lab_id) then
    insert into audit_log (lab_id, actor, action, target) values (old.lab_id, auth.uid(), 'chart.delete', old.id::text);
  end if;
  return null;
end
$$;

create trigger charts_before_write before insert or update on charts
  for each row execute function charts_before_write();
create trigger charts_audit after insert or update or delete on charts
  for each row execute function charts_audit();

revoke all on data_tables, charts from anon, authenticated;
revoke all on function request_data_table(uuid, text), chart_spec_ok(jsonb) from public, anon, authenticated;
grant select on data_tables to authenticated;
grant select, delete on charts to authenticated;
grant insert (lab_id, sha256, sheet, title, spec, protocol_id) on charts to authenticated;
grant update (sheet, title, spec, protocol_id) on charts to authenticated;
grant execute on function request_data_table(uuid, text), chart_spec_ok(jsonb) to authenticated;
