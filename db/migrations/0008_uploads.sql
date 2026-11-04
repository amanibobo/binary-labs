-- Uploads: files that come straight to us from a phone or desktop (decisions.md, "Phase 2
-- starts; uploads and our own storage"). The bytes live in the object store at
-- <lab_id>/files/<sha256>; an upload is a file_locations row on the lab's one upload source,
-- plus an uploads row saying who sent it, when, and for which experiment. The worker
-- processes it like any other location.

-- A new enum value can't be used in the transaction that adds it, so no parsed SQL below
-- names 'upload'; plpgsql bodies are only checked when they run.
alter type source_kind add value if not exists 'upload';
alter type audit_action add value if not exists 'file.upload';
alter type audit_action add value if not exists 'file.download';

-- Photos, screenshots and documents fit; videos come in a later slice. The worker reads a
-- whole file into memory, and one request has to finish on slow bench Wi-Fi.
create function upload_max_bytes() returns bigint
language sql immutable parallel safe as $$ select 50::bigint * 1024 * 1024 $$;

-- Enum-to-text casts are only stable, so the index predicate goes through this wrapper.
-- Sound as long as source_kind values are never renamed.
create function is_upload_kind(k source_kind) returns boolean
language sql immutable parallel safe as $$ select k::text = 'upload' $$;

create unique index sources_one_upload_per_lab_idx on sources (lab_id) where is_upload_kind(kind);

create table uploads (
  location_id uuid primary key references file_locations (id) on delete cascade,
  lab_id uuid not null references labs (id) on delete cascade,
  uploaded_by uuid references auth.users (id) on delete set null,
  person_id uuid,
  experiment_id uuid,
  uploaded_at timestamptz not null default now(),
  -- The uploader's own calendar day, so an evening photo isn't dated tomorrow in UTC.
  uploaded_on date not null,
  foreign key (person_id, lab_id) references people (id, lab_id) on delete set null (person_id),
  foreign key (experiment_id, lab_id) references experiments (id, lab_id) on delete set null (experiment_id)
);
create index uploads_lab_by_idx on uploads (lab_id, uploaded_by, uploaded_at desc);

alter table uploads enable row level security;
create policy uploads_select on uploads for select using (is_lab_member(lab_id));

-- How a member is named when they become a person on a label.
create function member_display_name(p_user_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select left(coalesce(
    nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(u.email, '@', 1), ''),
    'Lab member'
  ), 120)
  from auth.users u where u.id = p_user_id
$$;

-- Records one uploaded file whose bytes are already in the object store. Idempotent: the same
-- bytes again (a retry, or a second person) return the existing location, and a failed one
-- goes back to pending. Error codes: BL201 too large, 22023 a bad argument.
create function record_upload(
  p_lab_id uuid,
  p_sha256 text,
  p_size bigint,
  p_name text,
  p_experiment text,
  p_uploaded_on date,
  p_modified_at timestamptz
) returns table (location_id uuid, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_name text := left(regexp_replace(btrim(coalesce(p_name, '')), '[/\\[:cntrl:]]+', '-', 'g'), 200);
  v_experiment_name text := nullif(left(btrim(regexp_replace(coalesce(p_experiment, ''), '[/\\[:cntrl:]]+', '-', 'g')), 120), '');
  v_today date := (now() at time zone 'utc')::date;
  v_source uuid;
  v_person uuid;
  v_experiment uuid;
  v_location uuid;
begin
  if v_user is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'sha256 must be lowercase hex' using errcode = '22023';
  end if;
  if p_size is null or p_size < 0 then
    raise exception 'size must be a byte count' using errcode = '22023';
  end if;
  if p_size > upload_max_bytes() then
    raise exception 'file is larger than % bytes', upload_max_bytes() using errcode = 'BL201';
  end if;
  if v_name = '' then
    raise exception 'a file needs a name' using errcode = '22023';
  end if;
  if p_uploaded_on is null or p_uploaded_on not between v_today - 1 and v_today + 1 then
    raise exception 'upload date must be today' using errcode = '22023';
  end if;

  -- Creating the source on first use and re-pointing a hand-made one both converge here.
  insert into sources as s (lab_id, kind, root_path) values (p_lab_id, 'upload', '/')
  on conflict (lab_id) where is_upload_kind(kind) do update set root_path = '/'
  returning s.id into v_source;

  select p.id into v_person from people p where p.lab_id = p_lab_id and p.member_user_id = v_user;
  if v_person is null then
    insert into people as p (lab_id, display_name, member_user_id)
    values (p_lab_id, member_display_name(v_user), v_user)
    on conflict (lab_id, lower(btrim(display_name))) do update set member_user_id = excluded.member_user_id
      where p.member_user_id is null
    returning p.id into v_person;
  end if;

  if v_experiment_name is not null then
    select e.id into v_experiment from experiments e
    where e.lab_id = p_lab_id and lower(btrim(e.name)) = lower(v_experiment_name);
    if v_experiment is null then
      select e.id into v_experiment from experiments e
      where e.lab_id = p_lab_id
        and lower(v_experiment_name) in (select lower(btrim(a)) from unnest(e.aliases) a)
      order by e.created_at limit 1;
    end if;
    if v_experiment is null then
      insert into experiments as e (lab_id, name) values (p_lab_id, v_experiment_name)
      on conflict (lab_id, lower(btrim(name))) do update set name = e.name
      returning e.id into v_experiment;
    end if;
    select e.name into v_experiment_name from experiments e where e.id = v_experiment;
  end if;

  insert into file_locations as fl
    (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev)
  values (
    p_lab_id, v_source, p_sha256,
    '/Uploads/' || coalesce(v_experiment_name || '/', '') || v_name,
    v_name, p_size,
    case when p_modified_at between '1990-01-01' and now() then p_modified_at else now() end,
    p_sha256
  )
  on conflict (source_id, external_id) do nothing
  returning fl.id into v_location;

  if v_location is null then
    update file_locations fl set index_state = 'pending', index_error = null
    where fl.source_id = v_source and fl.external_id = p_sha256 and fl.index_state = 'failed';
    select fl.id into v_location from file_locations fl
    where fl.source_id = v_source and fl.external_id = p_sha256;
    duplicate := true;
  else
    insert into uploads (location_id, lab_id, uploaded_by, person_id, experiment_id, uploaded_on)
    values (v_location, p_lab_id, v_user, v_person, v_experiment, p_uploaded_on);
    insert into audit_log (lab_id, actor, action, target) values (p_lab_id, v_user, 'file.upload', p_sha256);
    duplicate := false;
  end if;

  -- clock_timestamp, not now(): a scan that started while this transaction ran must see a
  -- later request and run again, or the new location would wait for the next upload.
  update sources set scan_requested_at = clock_timestamp() where id = v_source;
  location_id := v_location;
  return next;
end
$$;

-- The upload page's list: this person's uploads, newest first, with how far each has got.
create function my_uploads(p_lab_id uuid, p_limit int default 30)
returns table (
  location_id uuid,
  sha256 text,
  name text,
  path text,
  experiment text,
  uploaded_at timestamptz,
  uploaded_on date,
  index_state index_state,
  index_error text,
  file_kind file_kind,
  has_preview boolean,
  label jsonb
)
language sql stable security invoker set search_path = public as $$
  select u.location_id, fl.sha256, fl.original_name, fl.path, e.name, u.uploaded_at, u.uploaded_on,
    fl.index_state, fl.index_error, b.file_kind,
    exists (select 1 from previews p where p.lab_id = p_lab_id and p.sha256 = fl.sha256),
    case when fl.sha256 is not null then label_json(p_lab_id, fl.sha256) end
  from uploads u
  join file_locations fl on fl.id = u.location_id
  left join blobs b on b.sha256 = fl.sha256
  left join experiments e on e.id = u.experiment_id
  where u.lab_id = p_lab_id and u.uploaded_by = auth.uid() and fl.deleted_at is null
  order by u.uploaded_at desc, u.location_id
  limit least(greatest(p_limit, 1), 100)
$$;

revoke all on function
  upload_max_bytes(), is_upload_kind(source_kind), member_display_name(uuid),
  record_upload(uuid, text, bigint, text, text, date, timestamptz), my_uploads(uuid, int)
from public, anon, authenticated;
grant select on uploads to authenticated;
grant execute on function
  upload_max_bytes(), is_upload_kind(source_kind), record_upload(uuid, text, bigint, text, text, date, timestamptz), my_uploads(uuid, int)
to authenticated;
