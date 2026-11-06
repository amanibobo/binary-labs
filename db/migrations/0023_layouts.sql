-- Charts round 1 (decisions.md, "charts round 1: layouts, replicates, fits and tests"): plate
-- layouts saved to use again, the chart specs that summarize repeats, and the protocol version
-- a chart was saved on.

alter type audit_action add value if not exists 'layout.create';
alter type audit_action add value if not exists 'layout.save';
alter type audit_action add value if not exists 'layout.delete';

-- A plate's layout, mirroring SampleLayout in apps/web/src/lib/layouts.ts: its size, the unit
-- its amounts are in, and groups of wells that repeat each other, each a blank, control,
-- standard or sample with an optional name, amount and dilution. No well twice, none off the
-- plate.
create function layout_ok(l jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(l) = 'object'
    and l ->> 'size' in ('96', '384')
    and jsonb_typeof(l -> 'unit') = 'string' and length(btrim(l ->> 'unit')) <= 24
    and jsonb_typeof(l -> 'groups') = 'array' and jsonb_array_length(l -> 'groups') <= 384
    and not exists (
      select 1 from jsonb_array_elements(l -> 'groups') g
      where not coalesce(
        jsonb_typeof(g) = 'object'
        and g ->> 'role' in ('blank', 'control', 'standard', 'sample')
        and jsonb_typeof(g -> 'name') = 'string' and length(btrim(g ->> 'name')) <= 60
        and (jsonb_typeof(g -> 'conc') = 'null' or (jsonb_typeof(g -> 'conc') = 'number' and (g ->> 'conc')::numeric >= 0))
        and (jsonb_typeof(g -> 'dilution') = 'null' or (jsonb_typeof(g -> 'dilution') = 'number' and (g ->> 'dilution')::numeric > 0))
        and jsonb_typeof(g -> 'wells') = 'array' and jsonb_array_length(g -> 'wells') between 1 and 384,
        false
      )
    )
    and not exists (
      select 1 from jsonb_array_elements(l -> 'groups') g, jsonb_array_elements(g -> 'wells') w
      where not coalesce(
        jsonb_typeof(w) = 'string'
        and (w #>> '{}') ~ '^[A-P]([1-9]|1[0-9]|2[0-4])$'
        and (l ->> 'size' = '384' or ((w #>> '{}') ~ '^[A-H]([1-9]|1[0-2])$')),
        false
      )
    )
    and (
      select count(*) = count(distinct w #>> '{}')
      from jsonb_array_elements(l -> 'groups') g, jsonb_array_elements(g -> 'wells') w
    ),
    false
  )
$$;

-- Where a chart of repeats reads them, mirroring Source in apps/web/src/lib/replicates.ts.
create function chart_source_ok(s jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(s) = 'object'
    and case s ->> 'kind'
      when 'columns' then
        jsonb_typeof(s -> 'columns') = 'array' and jsonb_array_length(s -> 'columns') between 1 and 24
        and not exists (select 1 from jsonb_array_elements_text(s -> 'columns') c where c !~ '^[A-Z]{1,3}$')
      when 'rows' then
        (s ->> 'key') ~ '^[A-Z]{1,3}$'
        and jsonb_typeof(s -> 'series') = 'array' and jsonb_array_length(s -> 'series') between 1 and 6
        and not exists (
          select 1 from jsonb_array_elements(s -> 'series') e
          where not coalesce(
            jsonb_typeof(e) = 'object'
            and length(btrim(e ->> 'name')) between 1 and 80
            and jsonb_typeof(e -> 'values') = 'array' and jsonb_array_length(e -> 'values') between 1 and 24
            and not exists (select 1 from jsonb_array_elements_text(e -> 'values') c where c !~ '^[A-Z]{1,3}$'),
            false
          )
        )
      when 'long' then (s ->> 'key') ~ '^[A-Z]{1,3}$' and (s ->> 'value') ~ '^[A-Z]{1,3}$'
      when 'plate' then
        jsonb_typeof(s -> 'plate') = 'object'
        and case s #>> '{plate,kind}'
          when 'grid' then (s #>> '{plate,rows}') ~ '^[A-Z]{1,3}$'
          when 'wells' then (s #>> '{plate,well}') ~ '^[A-Z]{1,3}$' and (s #>> '{plate,value}') ~ '^[A-Z]{1,3}$'
          when 'read' then jsonb_typeof(s #> '{plate,row}') = 'number' and (s #>> '{plate,row}')::numeric between 0 and 1000000
          else false
        end
        and layout_ok(s -> 'layout')
        and (jsonb_typeof(s -> 'layoutId') = 'null'
          or (s ->> 'layoutId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      else false
    end,
    false
  )
$$;

-- An axis of a chart of repeats: a title, a unit, a scale and an optional range.
create function chart_axis_ok(a jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(a) = 'object'
    and jsonb_typeof(a -> 'title') = 'string' and length(btrim(a ->> 'title')) <= 80
    and jsonb_typeof(a -> 'unit') = 'string' and length(btrim(a ->> 'unit')) <= 24
    and a ->> 'scale' in ('linear', 'log')
    and jsonb_typeof(a -> 'min') in ('null', 'number')
    and jsonb_typeof(a -> 'max') in ('null', 'number'),
    false
  )
$$;

-- Chart specs, mirroring ChartSpec in apps/web/src/lib/charts.ts: the x/y and plate charts as
-- in 0020 (an x/y chart may now name a log scale along x, never on bars), and the charts of
-- repeats: groups as bars or boxes with a named test, a standard curve with its fit and
-- samples, lines with a shaded spread, a dose-response curve on a log dose, and a histogram.
-- Rows saved before pass, as this accepts everything 0020's did.
create or replace function chart_spec_ok(s jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(s) = 'object'
    and length(s::text) <= 64000
    and s ->> 'version' = '1'
    and case
      when s ->> 'type' = 'heatmap' then
        jsonb_typeof(s -> 'plate') = 'object'
        and s -> 'plate' ->> 'size' in ('96', '384')
        and jsonb_typeof(s -> 'plate' -> 'source') = 'object'
        and case s #>> '{plate,source,kind}'
          when 'grid' then (s #>> '{plate,source,rows}') ~ '^[A-Z]{1,3}$'
          when 'wells' then (s #>> '{plate,source,well}') ~ '^[A-Z]{1,3}$' and (s #>> '{plate,source,value}') ~ '^[A-Z]{1,3}$'
          when 'read' then
            case when jsonb_typeof(s #> '{plate,source,row}') = 'number'
              then (s #>> '{plate,source,row}')::numeric between 0 and 1000000
                and (s #>> '{plate,source,row}')::numeric = floor((s #>> '{plate,source,row}')::numeric)
              else false end
          else false
        end
        and jsonb_typeof(s -> 'value') = 'object'
      when s ->> 'type' in ('line', 'scatter', 'bar') then
        s ->> 'legend' in ('top', 'right', 'bottom')
        and jsonb_typeof(s -> 'x') = 'object'
        and (s -> 'x' ->> 'column') ~ '^[A-Z]{1,3}$'
        and coalesce(s -> 'x' ->> 'scale', 'linear') in ('linear', 'log')
        and not (s ->> 'type' = 'bar' and coalesce(s -> 'x' ->> 'scale', 'linear') = 'log')
        and jsonb_typeof(s -> 'y') = 'object'
        and s -> 'y' ->> 'scale' in ('linear', 'log')
        and not (s ->> 'type' = 'bar' and s -> 'y' ->> 'scale' = 'log')
        and jsonb_typeof(s -> 'series') = 'array'
        and jsonb_array_length(s -> 'series') between 1
          and (case s ->> 'type' when 'scatter' then 3 when 'bar' then 6 else 12 end)
        and not exists (
          select 1 from jsonb_array_elements(s -> 'series') e
          where not coalesce(
            jsonb_typeof(e) = 'object'
            and (e ->> 'column') ~ '^[A-Z]{1,3}$'
            and length(btrim(e ->> 'name')) between 1 and 80
            and e ->> 'color' in ('blue', 'orange', 'aqua', 'violet', 'magenta', 'green')
            and coalesce(e ->> 'stroke', 'solid') in ('solid', 'dashed')
            and (s ->> 'type' = 'line' or coalesce(e ->> 'stroke', 'solid') = 'solid')
            and (jsonb_typeof(e -> 'error') = 'null' or (e ->> 'error') ~ '^[A-Z]{1,3}$')
            and (e -> 'x' is null or jsonb_typeof(e -> 'x') = 'null'
              or (s ->> 'type' <> 'bar' and (e ->> 'x') ~ '^[A-Z]{1,3}$')),
            false
          )
        )
      when s ->> 'type' in ('groups', 'curve', 'band', 'dose') then
        chart_source_ok(s -> 'source')
        and s ->> 'spread' in ('sd', 'sem', 'ci')
        and jsonb_typeof(s -> 'points') = 'boolean'
        and jsonb_typeof(s -> 'blank') = 'boolean'
        and chart_axis_ok(s -> 'y')
        and case s ->> 'type'
          when 'groups' then
            s ->> 'mark' in ('bar', 'box')
            and s ->> 'test' in ('none', 'welch', 'anova', 'control')
            and (jsonb_typeof(s -> 'control') = 'null' or (jsonb_typeof(s -> 'control') = 'string' and length(s ->> 'control') <= 80))
            and jsonb_typeof(s -> 'marks') = 'boolean'
            and jsonb_typeof(s -> 'x') = 'object' and jsonb_typeof(s -> 'x' -> 'title') = 'string' and length(btrim(s #>> '{x,title}')) <= 80
            and not (s ->> 'mark' = 'bar' and s -> 'y' ->> 'scale' = 'log')
          when 'curve' then
            chart_axis_ok(s -> 'x')
            and s ->> 'fit' in ('none', 'line', 'origin')
            and (jsonb_typeof(s -> 'unknowns') = 'null'
              or (jsonb_typeof(s -> 'unknowns') = 'object' and case s #>> '{unknowns,kind}'
                when 'layout' then s #>> '{source,kind}' = 'plate'
                when 'table' then length(s #>> '{unknowns,table}') between 1 and 200
                  and (s #>> '{unknowns,label}') ~ '^[A-Z]{1,3}$'
                  and (s #>> '{unknowns,value}') ~ '^[A-Z]{1,3}$'
                  and (jsonb_typeof(s #> '{unknowns,dilution}') = 'null' or (s #>> '{unknowns,dilution}') ~ '^[A-Z]{1,3}$')
                else false end))
          when 'band' then
            chart_axis_ok(s -> 'x')
            and jsonb_typeof(s -> 'band') = 'boolean'
            and s ->> 'legend' in ('top', 'right', 'bottom')
          when 'dose' then
            chart_axis_ok(s -> 'x')
            and s -> 'x' ->> 'scale' = 'log'
            and s ->> 'fit' in ('points', 'means')
          else false
        end
      when s ->> 'type' = 'histogram' then
        (s ->> 'column') ~ '^[A-Z]{1,3}$'
        and (jsonb_typeof(s -> 'bin') = 'null' or (jsonb_typeof(s -> 'bin') = 'number' and (s ->> 'bin')::numeric > 0))
        and jsonb_typeof(s -> 'x') = 'object'
        and jsonb_typeof(s -> 'x' -> 'title') = 'string' and length(btrim(s #>> '{x,title}')) <= 80
        and jsonb_typeof(s -> 'x' -> 'unit') = 'string' and length(btrim(s #>> '{x,unit}')) <= 24
        and jsonb_typeof(s -> 'y') = 'object' and jsonb_typeof(s -> 'y' -> 'title') = 'string'
      else false
    end,
    false
  )
$$;

-- Layouts saved to use again. A layout on a protocol is offered for that protocol's next plate
-- ("Use the layout from Bradford assay"); a chart keeps its own copy in its spec, so changing or
-- deleting a saved layout never changes a saved chart.
create table sample_layouts (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  protocol_id uuid,
  -- The plate it was first marked on, when there was one.
  sha256 text references blobs (sha256),
  layout jsonb not null check (layout_ok(layout)),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (protocol_id, lab_id) references protocols (id, lab_id) on delete set null (protocol_id)
);
create index sample_layouts_lab_idx on sample_layouts (lab_id, updated_at desc);
create index sample_layouts_protocol_idx on sample_layouts (protocol_id) where protocol_id is not null;
create index sample_layouts_sha_idx on sample_layouts (sha256) where sha256 is not null;

alter table sample_layouts enable row level security;
create policy sample_layouts_select on sample_layouts for select using (is_lab_member(lab_id));
create policy sample_layouts_insert on sample_layouts for insert
  with check (is_lab_member(lab_id) and created_by = auth.uid());
create policy sample_layouts_update on sample_layouts for update
  using (is_lab_member(lab_id)) with check (is_lab_member(lab_id));
create policy sample_layouts_delete on sample_layouts for delete using (is_lab_member(lab_id));

-- A layout stays in its lab; its protocol and plate must be the lab's (BL103, BL104), and an
-- archived protocol takes no new layouts (BL102).
create function sample_layouts_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.lab_id := old.lab_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.sha256 := old.sha256;
  elsif new.sha256 is not null and not exists (
    select 1 from file_locations fl where fl.lab_id = new.lab_id and fl.sha256 = new.sha256 and fl.deleted_at is null
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
  new.name := btrim(new.name);
  new.updated_at := clock_timestamp();
  return new;
end
$$;

create function sample_layouts_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into audit_log (lab_id, actor, action, target) values (new.lab_id, auth.uid(), 'layout.create', new.id::text);
  elsif tg_op = 'UPDATE' then
    insert into audit_log (lab_id, actor, action, target) values (new.lab_id, auth.uid(), 'layout.save', new.id::text);
  -- A lab being deleted takes its layouts with it; that isn't someone deleting one.
  elsif exists (select 1 from labs where id = old.lab_id) then
    insert into audit_log (lab_id, actor, action, target) values (old.lab_id, auth.uid(), 'layout.delete', old.id::text);
  end if;
  return null;
end
$$;

create trigger sample_layouts_before_write before insert or update on sample_layouts
  for each row execute function sample_layouts_before_write();
create trigger sample_layouts_audit after insert or update or delete on sample_layouts
  for each row execute function sample_layouts_audit();

revoke all on sample_layouts from anon, authenticated;
revoke all on function layout_ok(jsonb), chart_source_ok(jsonb), chart_axis_ok(jsonb) from public, anon, authenticated;
grant select, delete on sample_layouts to authenticated;
grant insert (lab_id, name, protocol_id, sha256, layout) on sample_layouts to authenticated;
grant update (name, protocol_id, layout) on sample_layouts to authenticated;
grant execute on function layout_ok(jsonb), chart_source_ok(jsonb), chart_axis_ok(jsonb) to authenticated;

-- The protocol version a chart was last saved on: set by the database from the protocol's
-- current version whenever the chart is saved, never by members, so "Made from" can say
-- "Bradford assay, version 3" and mean the version the lab was following then.
alter table charts add column protocol_version_id uuid references protocol_versions (id) on delete set null;

create or replace function charts_before_write() returns trigger
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
  new.protocol_version_id := (select p.current_version_id from protocols p where p.id = new.protocol_id);
  new.title := btrim(new.title);
  new.updated_at := clock_timestamp();
  return new;
end
$$;
