-- Folder paths here are relative to the source's root_path, with no leading or
-- trailing slash; the root folder is ''. Dropbox paths are case-insensitive, so a
-- location is under the root when its lowercased path starts with the lowercased
-- root plus '/'. Trimming the root's trailing slash makes a root of '/' match every path.
create function folder_tree(p_lab_id uuid)
returns table (path text, parent text, direct_files bigint, total_files bigint)
language sql stable security invoker set search_path = public as $$
  with located as (
    select regexp_replace(substr(fl.path, length(rtrim(s.root_path, '/')) + 2), '/?[^/]*$', '') as folder
    from file_locations fl
    join sources s on s.id = fl.source_id
    where fl.lab_id = p_lab_id
      and fl.deleted_at is null
      and fl.index_state = 'indexed'
      and starts_with(lower(fl.path), lower(rtrim(s.root_path, '/')) || '/')
  ),
  per_folder as (
    select l.folder, string_to_array(l.folder, '/') as segments, count(*) as files
    from located l
    group by l.folder
  ),
  -- Each folder's files count toward itself and every ancestor, root included.
  ancestry as (
    select array_to_string(pf.segments[1:d], '/') as path, pf.folder, pf.files
    from per_folder pf, generate_series(0, cardinality(pf.segments)) as d
  )
  select a.path,
    case when a.path = '' then null else regexp_replace(a.path, '/?[^/]*$', '') end as parent,
    coalesce(sum(a.files) filter (where a.folder = a.path), 0)::bigint as direct_files,
    sum(a.files)::bigint as total_files
  from ancestry a
  group by a.path
  order by a.path
$$;

create function folder_files(p_lab_id uuid, p_path text, p_limit int default 100, p_offset int default 0)
returns table (
  sha256 text,
  file_kind file_kind,
  mime text,
  size bigint,
  has_preview boolean,
  snippet text,
  locations jsonb
)
language sql stable security invoker set search_path = public as $$
  with live as (
    select fl.id, fl.sha256, fl.source_id, s.kind as source_kind, fl.path, fl.original_name, fl.modified_at,
      case when starts_with(lower(fl.path), lower(rtrim(s.root_path, '/')) || '/')
        then regexp_replace(substr(fl.path, length(rtrim(s.root_path, '/')) + 2), '/?[^/]*$', '')
      end as folder
    from file_locations fl
    join sources s on s.id = fl.source_id
    where fl.lab_id = p_lab_id
      and fl.deleted_at is null
      and fl.index_state = 'indexed'
  ),
  page as (
    select l.id, l.sha256, l.original_name
    from live l
    where l.folder = p_path
    order by lower(l.original_name), l.id
    limit p_limit
    offset p_offset
  )
  select p.sha256,
    b.file_kind,
    b.mime,
    b.size,
    exists (select 1 from previews pr where pr.lab_id = p_lab_id and pr.sha256 = p.sha256) as has_preview,
    (select c.text from chunks c where c.lab_id = p_lab_id and c.sha256 = p.sha256 and c.ord = 1) as snippet,
    (
      select jsonb_agg(jsonb_build_object(
        'id', l.id,
        'source_id', l.source_id,
        'source_kind', l.source_kind,
        'path', l.path,
        'original_name', l.original_name,
        'modified_at', l.modified_at
      ) order by l.id <> p.id, l.modified_at desc, l.id)
      from live l
      where l.sha256 = p.sha256
    ) as locations
  from page p
  join blobs b on b.sha256 = p.sha256
  order by lower(p.original_name), p.id
$$;

revoke all on function folder_tree(uuid), folder_files(uuid, text, int, int) from public, anon;
grant execute on function folder_tree(uuid), folder_files(uuid, text, int, int) to authenticated;
