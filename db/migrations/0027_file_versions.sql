-- The lab drive (decisions.md "the lab drive: what a file is across edits"). A file across
-- edits is its place, one file_locations row; a version is the content found there, from the
-- first time it was read there. Until now a changed file's new sha256 was written over the
-- old one and the old content had no row saying where it had lived.

create table file_versions (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  location_id uuid not null references file_locations (id) on delete cascade,
  number int not null check (number > 0),
  sha256 text not null references blobs (sha256),
  size bigint not null check (size >= 0),
  -- The name and folder the file had when this content was read, so history can say "renamed".
  path text not null,
  original_name text not null,
  -- When the source says this content was saved, and when Binary first read it here.
  modified_at timestamptz not null,
  seen_at timestamptz not null default now(),
  -- When this version's own bytes were put in our store at <lab_id>/files/<sha256>, unchanged.
  -- Null until the worker has kept them, and for good when the content was gone from its
  -- source before it could.
  kept_at timestamptz,
  unique (location_id, number)
);
create index file_versions_lab_sha_idx on file_versions (lab_id, sha256);
create index file_versions_unkept_idx on file_versions (location_id) where kept_at is null;

-- Every writer of a location goes through this, so none can forget: the scan, uploads, the
-- instrument uploader and imports. The update that fires it holds the location's row lock,
-- which orders two writes to one file. Reading the same content again adds nothing.
create function record_file_version() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_last file_versions;
begin
  if new.sha256 is null then
    return new;
  end if;
  select * into v_last from file_versions fv where fv.location_id = new.id order by fv.number desc limit 1;
  if found and v_last.sha256 = new.sha256 then
    return new;
  end if;
  insert into file_versions (lab_id, location_id, number, sha256, size, path, original_name, modified_at)
  select new.lab_id, new.id, coalesce(v_last.number, 0) + 1, new.sha256, b.size, new.path, new.original_name, new.modified_at
  from blobs b where b.sha256 = new.sha256;

  -- What a person called this file follows it to its next version. The machine's fields
  -- (summary, outcome, conditions) are left empty with no prompt version, so the label job
  -- reads them from the new content and leaves the person's values alone.
  if v_last.sha256 is not null then
    insert into labels (lab_id, sha256, status, clean_name, date, experiment_id, person_id, instrument, tags,
      confidence, source, reason, note_kind)
    select l.lab_id, new.sha256, l.status, l.clean_name, l.date, l.experiment_id, l.person_id, l.instrument, l.tags,
      l.confidence, l.source, l.reason, l.note_kind
    from labels l
    where l.lab_id = new.lab_id and l.sha256 = v_last.sha256 and l.status in ('accepted', 'corrected')
    on conflict (lab_id, sha256) do nothing;
  end if;
  return new;
end
$$;

create trigger file_locations_version
after insert or update of sha256 on file_locations
for each row execute function record_file_version();

-- History starts here: each file already read gets version 1 with the content it has today.
insert into file_versions (lab_id, location_id, number, sha256, size, path, original_name, modified_at, seen_at)
select fl.lab_id, fl.id, 1, fl.sha256, b.size, fl.path, fl.original_name, fl.modified_at, coalesce(fl.indexed_at, fl.seen_at)
from file_locations fl join blobs b on b.sha256 = fl.sha256;

alter table file_versions enable row level security;
create policy file_versions_select on file_versions for select using (is_lab_member(lab_id));

-- An older version's content is visible while the file it belonged to is still in the lab.
create policy blobs_select_versions on blobs for select using (
  exists (
    select 1 from file_versions fv join file_locations fl on fl.id = fv.location_id
    where fv.sha256 = blobs.sha256 and fl.deleted_at is null and is_lab_member(fv.lab_id)
  )
);

-- The drive's rows: one per content that lives in the lab now, under the folder it falls in
-- when the drive is arranged by experiment, person or month. Copies of one content are one
-- row, standing at the place with the longest history. A file being read again after an edit
-- stays, showing the last content Binary read.
create function drive_entries(p_lab_id uuid, p_by text)
returns table (
  location_id uuid,
  sha256 text,
  versions bigint,
  modified_at timestamptz,
  title text,
  folder_key text,
  folder_name text
)
language sql stable security invoker set search_path = public as $$
  select distinct on (fl.sha256)
    fl.id,
    fl.sha256,
    v.n,
    fl.modified_at,
    coalesce(case when l.status <> 'needs_look' then l.clean_name end, fl.original_name),
    case p_by
      when 'experiment' then coalesce(l.experiment_id::text, '')
      when 'person' then coalesce(l.person_id::text, '')
      else to_char(coalesce(l.date, (fl.modified_at at time zone 'UTC')::date), 'YYYY-MM')
    end,
    case p_by when 'experiment' then e.name when 'person' then p.display_name end
  from file_locations fl
  cross join lateral (select count(*) as n from file_versions fv where fv.location_id = fl.id) v
  left join labels l on l.lab_id = fl.lab_id and l.sha256 = fl.sha256
  left join experiments e on e.id = l.experiment_id
  left join people p on p.id = l.person_id
  where fl.lab_id = p_lab_id
    and fl.deleted_at is null
    and fl.sha256 is not null
    and p_by in ('experiment', 'person', 'month')
  order by fl.sha256, v.n desc, fl.modified_at desc, fl.id
$$;

-- The folders of one arrangement. A key of '' holds the files with no experiment or person yet.
create function drive_folders(p_lab_id uuid, p_by text)
returns table (key text, name text, files bigint, edited bigint, changed_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select d.folder_key, d.folder_name, count(*), count(*) filter (where d.versions > 1), max(d.modified_at)
  from drive_entries(p_lab_id, p_by) d
  group by d.folder_key, d.folder_name
  order by d.folder_key
$$;

-- One folder's files, shaped like folder_files rows plus how many versions each has. The
-- first location of a row is the place its history is read from.
create function drive_files(p_lab_id uuid, p_by text, p_key text, p_limit int default 100, p_offset int default 0)
returns table (
  sha256 text,
  file_kind file_kind,
  mime text,
  size bigint,
  has_preview boolean,
  snippet text,
  locations jsonb,
  label jsonb,
  versions bigint
)
language sql stable security invoker set search_path = public as $$
  with page as (
    select d.location_id, d.sha256, d.versions, d.title
    from drive_entries(p_lab_id, p_by) d
    where d.folder_key = p_key
    order by lower(d.title), d.location_id
    limit p_limit
    offset p_offset
  )
  select p.sha256,
    b.file_kind,
    b.mime,
    b.size,
    exists (select 1 from previews pr where pr.lab_id = p_lab_id and pr.sha256 = p.sha256),
    (select c.text from chunks c where c.lab_id = p_lab_id and c.sha256 = p.sha256 and c.ord = 1),
    (
      select jsonb_agg(jsonb_build_object(
        'id', l.id,
        'source_id', l.source_id,
        'source_kind', s.kind,
        'path', l.path,
        'original_name', l.original_name,
        'modified_at', l.modified_at
      ) order by l.id <> p.location_id, l.modified_at desc, l.id)
      from file_locations l join sources s on s.id = l.source_id
      where l.lab_id = p_lab_id and l.sha256 = p.sha256 and l.deleted_at is null
    ),
    label_json(p_lab_id, p.sha256),
    p.versions
  from page p
  join blobs b on b.sha256 = p.sha256
  order by lower(p.title), p.location_id
$$;

-- Every version of one file, oldest first, each with the label its content has and who it
-- came from where the source says: the person who uploaded it, or the instrument that sent it.
create function file_history(p_lab_id uuid, p_location_id uuid)
returns table (
  id uuid,
  number int,
  sha256 text,
  file_kind file_kind,
  mime text,
  size bigint,
  path text,
  original_name text,
  modified_at timestamptz,
  seen_at timestamptz,
  has_preview boolean,
  label jsonb,
  source_kind source_kind,
  who text,
  kept boolean
)
language sql stable security invoker set search_path = public as $$
  select fv.id, fv.number, fv.sha256, b.file_kind, b.mime, fv.size, fv.path, fv.original_name,
    fv.modified_at, fv.seen_at,
    exists (select 1 from previews pr where pr.lab_id = p_lab_id and pr.sha256 = fv.sha256),
    label_json(p_lab_id, fv.sha256),
    s.kind,
    coalesce(
      (select pe.display_name from uploads u join people pe on pe.id = u.person_id where u.location_id = fl.id),
      (select i.name from instruments i where i.source_id = fl.source_id)
    ),
    fv.kept_at is not null
  from file_versions fv
  join file_locations fl on fl.id = fv.location_id
  join sources s on s.id = fl.source_id
  join blobs b on b.sha256 = fv.sha256
  where fv.lab_id = p_lab_id and fv.location_id = p_location_id and fl.deleted_at is null
  order by fv.number
$$;

-- The extracted text of one version, to show what changed. Like file_text, but an older
-- version's content has no live location of its own, so membership is checked on the version.
create function version_text(p_lab_id uuid, p_version_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select e.content
  from file_versions fv
  join file_locations fl on fl.id = fv.location_id
  join extractions e on e.sha256 = fv.sha256
  where fv.id = p_version_id
    and fv.lab_id = p_lab_id
    and fl.deleted_at is null
    and e.kind in ('text', 'table')
    and is_lab_member(p_lab_id)
  order by e.created_at desc
  limit 1
$$;

-- What keeping every version's bytes costs a lab: each content is stored once however many
-- places or versions hold it. `waiting` are contents not kept yet.
create function lab_originals(p_lab_id uuid)
returns table (kept_files bigint, kept_bytes bigint, waiting_files bigint, waiting_bytes bigint)
language sql stable security invoker set search_path = public as $$
  with contents as (
    select fv.sha256, max(fv.size) as size, bool_or(fv.kept_at is not null) as kept
    from file_versions fv
    where fv.lab_id = p_lab_id
    group by fv.sha256
  )
  select count(*) filter (where c.kept), coalesce(sum(c.size) filter (where c.kept), 0)::bigint,
    count(*) filter (where not c.kept), coalesce(sum(c.size) filter (where not c.kept), 0)::bigint
  from contents c
$$;

revoke all on file_versions from anon, authenticated;
revoke all on function
  record_file_version(),
  drive_entries(uuid, text),
  drive_folders(uuid, text),
  drive_files(uuid, text, text, int, int),
  file_history(uuid, uuid),
  version_text(uuid, uuid),
  lab_originals(uuid)
from public, anon, authenticated;
grant select on file_versions to authenticated;
grant execute on function
  drive_entries(uuid, text),
  drive_folders(uuid, text),
  drive_files(uuid, text, text, int, int),
  file_history(uuid, uuid),
  version_text(uuid, uuid),
  lab_originals(uuid)
to authenticated;
