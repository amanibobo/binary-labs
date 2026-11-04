-- Talk-throughs: a person records themselves explaining a procedure, the worker transcribes
-- it and drafts numbered steps, and a person reviews the draft before it becomes a protocol
-- version (decisions.md, "speech-to-text: ElevenLabs, with local Whisper as the alternative"
-- and "talk-throughs"). The audio is an upload like any other, under
-- <lab_id>/files/<sha256>; the transcript is an extraction, so it's cached and searchable.

-- A new enum value can't be used in the transaction that adds it, so no parsed SQL below
-- names these; plpgsql bodies are only checked when they run.
alter type file_kind add value if not exists 'audio';
alter type extraction_kind add value if not exists 'transcript';
alter type model_call_purpose add value if not exists 'transcript';
alter type model_call_purpose add value if not exists 'steps';

-- 30 minutes of our own recording is about 15 MB; a phone's voice memo of the same length is
-- 15 to 30 MB. 100 MB leaves room for a longer or less compressed file while one request
-- still finishes on bench Wi-Fi and the worker can hold it in memory.
create function audio_max_bytes() returns bigint
language sql immutable parallel safe as $$ select 100::bigint * 1024 * 1024 $$;

-- How far drafting has got once the transcript exists. "failed" may work on a retry (the
-- model couldn't be reached); "unavailable" won't (no model configured, no speech heard, or
-- an answer we couldn't use), so the page offers the transcript instead.
create type talk_through_draft as enum ('waiting', 'ready', 'failed', 'unavailable');

create table talk_throughs (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  -- The audio. One talk-through per recording, so a retried upload finds the first.
  location_id uuid not null unique references file_locations (id) on delete cascade,
  kind protocol_kind not null,
  -- The page it's for and the version on screen while recording; both null for a new page.
  -- Using the steps saves on top of that version, so anyone's save since is caught.
  protocol_id uuid,
  base_version_id uuid,
  recorded_by uuid references auth.users (id) on delete set null,
  recorded_at timestamptz not null default now(),
  duration_ms int check (duration_ms is null or duration_ms > 0),
  draft talk_through_draft not null default 'waiting',
  draft_title text check (draft_title is null or length(btrim(draft_title)) between 1 and 200),
  draft_body text check (draft_body is null or length(draft_body) <= 200000),
  draft_model text,
  drafted_at timestamptz,
  draft_error text check (draft_error is null or length(draft_error) <= 500),
  -- The version that took these steps; set once.
  used_version_id uuid references protocol_versions (id) on delete set null,
  foreign key (protocol_id, lab_id) references protocols (id, lab_id) on delete cascade,
  foreign key (base_version_id, protocol_id) references protocol_versions (id, protocol_id),
  check ((protocol_id is null) = (base_version_id is null)),
  check ((draft = 'ready') = (draft_title is not null and draft_body is not null and drafted_at is not null)),
  check ((draft in ('failed', 'unavailable')) = (draft_error is not null))
);
create index talk_throughs_lab_protocol_idx on talk_throughs (lab_id, protocol_id, recorded_at desc)
  where used_version_id is null;

alter table talk_throughs enable row level security;
create policy talk_throughs_select on talk_throughs for select using (is_lab_member(lab_id));

-- record_upload's body, now shared with record_talk_through: the cap and the folder differ.
-- A file lands at /Uploads/<folder or experiment>/<name>. Not callable by members directly.
create function record_file(
  p_lab_id uuid,
  p_sha256 text,
  p_size bigint,
  p_max_bytes bigint,
  p_name text,
  p_experiment text,
  p_folder text,
  p_uploaded_on date,
  p_modified_at timestamptz
) returns table (location_id uuid, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_name text := left(regexp_replace(btrim(coalesce(p_name, '')), '[/\\[:cntrl:]]+', '-', 'g'), 200);
  v_experiment_name text := nullif(left(btrim(regexp_replace(coalesce(p_experiment, ''), '[/\\[:cntrl:]]+', '-', 'g')), 120), '');
  v_folder text;
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
  if p_size > p_max_bytes then
    raise exception 'file is larger than % bytes', p_max_bytes using errcode = 'BL201';
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
  v_folder := coalesce(p_folder, v_experiment_name);

  insert into file_locations as fl
    (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev)
  values (
    p_lab_id, v_source, p_sha256,
    '/Uploads/' || coalesce(v_folder || '/', '') || v_name,
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

-- Same arguments and answers as before; the body moved into record_file.
create or replace function record_upload(
  p_lab_id uuid,
  p_sha256 text,
  p_size bigint,
  p_name text,
  p_experiment text,
  p_uploaded_on date,
  p_modified_at timestamptz
) returns table (location_id uuid, duplicate boolean)
language sql security definer set search_path = public as $$
  select * from record_file(
    p_lab_id, p_sha256, p_size, upload_max_bytes(), p_name, p_experiment, null, p_uploaded_on, p_modified_at
  )
$$;

-- Records a recording whose bytes are already in the object store, and the talk-through it
-- starts. Idempotent like record_upload: the same audio again returns the first talk-through.
-- Error codes: BL201 too large, BL102 the page is archived, BL103 no such page, 22023 a bad argument.
create function record_talk_through(
  p_lab_id uuid,
  p_sha256 text,
  p_size bigint,
  p_name text,
  p_uploaded_on date,
  p_modified_at timestamptz,
  p_kind protocol_kind,
  p_protocol_id uuid,
  p_base_version_id uuid,
  p_duration_ms int
) returns table (talk_through_id uuid, location_id uuid, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_kind protocol_kind := p_kind;
  v_archived timestamptz;
  v_location uuid;
  v_duplicate boolean;
  v_id uuid;
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  if (p_protocol_id is null) <> (p_base_version_id is null) then
    raise exception 'a page and its version come together' using errcode = '22023';
  end if;
  if p_protocol_id is not null then
    select p.kind, p.archived_at into v_kind, v_archived
    from protocols p where p.id = p_protocol_id and p.lab_id = p_lab_id;
    if not found then
      raise exception 'no such protocol' using errcode = 'BL103';
    end if;
    if v_archived is not null then
      raise exception 'this page is archived' using errcode = 'BL102';
    end if;
    if not exists (
      select 1 from protocol_versions v where v.id = p_base_version_id and v.protocol_id = p_protocol_id
    ) then
      raise exception 'that version is not of this page' using errcode = '22023';
    end if;
  end if;
  if v_kind is null then
    raise exception 'a new page needs a kind' using errcode = '22023';
  end if;
  if p_duration_ms is not null and p_duration_ms <= 0 then
    raise exception 'duration must be positive' using errcode = '22023';
  end if;

  select r.location_id, r.duplicate into v_location, v_duplicate
  from record_file(
    p_lab_id, p_sha256, p_size, audio_max_bytes(), p_name, null, 'Talk-throughs', p_uploaded_on, p_modified_at
  ) r;

  insert into talk_throughs as t (lab_id, location_id, kind, protocol_id, base_version_id, recorded_by, duration_ms)
  values (p_lab_id, v_location, v_kind, p_protocol_id, p_base_version_id, auth.uid(), p_duration_ms)
  -- By constraint name: a bare location_id here would clash with the output column.
  on conflict on constraint talk_throughs_location_id_key do nothing
  returning t.id into v_id;
  if v_id is null then
    select t.id into v_id from talk_throughs t where t.location_id = v_location;
    -- A retried recording whose draft failed gets another go.
    update talk_throughs t set draft = 'waiting', draft_error = null where t.id = v_id and t.draft = 'failed';
  end if;

  talk_through_id := v_id;
  location_id := v_location;
  duplicate := v_duplicate;
  return next;
end
$$;

-- One talk-through as its page shows it: where the audio has got, the transcript and the
-- draft. Transcripts are extractions, which are shared across labs and closed to members, so
-- this is security definer and checks membership itself.
create function talk_through(p_id uuid)
returns table (
  id uuid,
  kind protocol_kind,
  protocol_id uuid,
  protocol_title text,
  base_version_id uuid,
  base_version int,
  recorded_by uuid,
  recorded_at timestamptz,
  duration_ms int,
  location_id uuid,
  sha256 text,
  name text,
  index_state index_state,
  index_error text,
  transcript text,
  draft talk_through_draft,
  draft_title text,
  draft_body text,
  draft_error text,
  used_protocol_id uuid,
  used_version int
)
language sql stable security definer set search_path = public as $$
  select t.id, t.kind, t.protocol_id, cv.title, t.base_version_id, bv.version,
    t.recorded_by, t.recorded_at, t.duration_ms,
    fl.id, fl.sha256, fl.original_name, fl.index_state, fl.index_error,
    tr.content,
    t.draft, t.draft_title, t.draft_body, t.draft_error,
    uv.protocol_id, uv.version
  from talk_throughs t
  join file_locations fl on fl.id = t.location_id
  left join protocols p on p.id = t.protocol_id
  left join protocol_versions cv on cv.id = p.current_version_id
  left join protocol_versions bv on bv.id = t.base_version_id
  left join protocol_versions uv on uv.id = t.used_version_id
  left join lateral (
    select e.content from extractions e
    where e.sha256 = fl.sha256 and e.kind::text = 'transcript'
    order by e.created_at desc limit 1
  ) tr on true
  where t.id = p_id and is_lab_member(t.lab_id) and fl.deleted_at is null
$$;

-- Talk-throughs nobody has used yet: a page's, or with no page, the caller's own new-page ones.
create function open_talk_throughs(p_lab_id uuid, p_protocol_id uuid default null)
returns table (
  id uuid,
  kind protocol_kind,
  recorded_by uuid,
  recorded_at timestamptz,
  duration_ms int,
  index_state index_state,
  draft talk_through_draft,
  draft_title text
)
language sql stable security invoker set search_path = public as $$
  select t.id, t.kind, t.recorded_by, t.recorded_at, t.duration_ms, fl.index_state, t.draft, t.draft_title
  from talk_throughs t
  join file_locations fl on fl.id = t.location_id
  where t.lab_id = p_lab_id and t.used_version_id is null and fl.deleted_at is null
    and (case when p_protocol_id is null then t.protocol_id is null and t.recorded_by = auth.uid()
         else t.protocol_id = p_protocol_id end)
  order by t.recorded_at desc, t.id
  limit 20
$$;

-- Sends a failed transcription or a failed draft round again.
create function retry_talk_through(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_lab uuid;
  v_location uuid;
  v_source uuid;
begin
  select t.lab_id, t.location_id into v_lab, v_location from talk_throughs t where t.id = p_id;
  if not found or not is_lab_member(v_lab) then
    raise exception 'no such talk-through' using errcode = 'BL103';
  end if;
  update file_locations fl set index_state = 'pending', index_error = null
  where fl.id = v_location and fl.index_state = 'failed'
  returning fl.source_id into v_source;
  if v_source is not null then
    update sources set scan_requested_at = clock_timestamp() where id = v_source;
  end if;
  update talk_throughs t set draft = 'waiting', draft_error = null where t.id = p_id and t.draft = 'failed';
end
$$;

-- Marks a talk-through used by a version the caller just saved, once.
create function mark_talk_through_used(p_id uuid, p_version_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update talk_throughs t set used_version_id = p_version_id
  where t.id = p_id and t.used_version_id is null and is_lab_member(t.lab_id)
    and exists (
      select 1 from protocol_versions v
      where v.id = p_version_id and v.lab_id = t.lab_id and v.author = auth.uid()
        and (t.protocol_id is null or v.protocol_id = t.protocol_id)
    );
  if not found then
    raise exception 'these steps are already on a page' using errcode = 'BL105';
  end if;
end
$$;

-- "Use these steps": a new page, or the next version of the page it was recorded for, saved
-- on top of p_base_version_id (BL101 if someone saved since). The audio is linked to the page
-- and the talk-through is marked used in the same transaction.
create function use_talk_through(
  p_id uuid,
  p_kind protocol_kind,
  p_base_version_id uuid,
  p_title text,
  p_body text,
  p_note text default null
)
returns table (protocol_id uuid, version_id uuid, version int)
language plpgsql security invoker set search_path = public as $$
declare
  v_lab uuid;
  v_protocol uuid;
  v_used uuid;
  v_sha text;
  v_saved_protocol uuid;
  v_saved_version uuid;
  v_number int;
begin
  select t.lab_id, t.protocol_id, t.used_version_id, fl.sha256 into v_lab, v_protocol, v_used, v_sha
  from talk_throughs t join file_locations fl on fl.id = t.location_id
  where t.id = p_id;
  if not found then
    raise exception 'no such talk-through' using errcode = 'BL103';
  end if;
  if v_used is not null then
    raise exception 'these steps are already on a page' using errcode = 'BL105';
  end if;
  if v_sha is null then
    raise exception 'the recording is still being read' using errcode = 'BL106';
  end if;
  if v_protocol is null then
    select c.protocol_id, c.version_id, c.version into v_saved_protocol, v_saved_version, v_number
    from create_protocol(v_lab, p_kind, p_title, p_body, p_note, v_sha) c;
  else
    select s.protocol_id, s.version_id, s.version into v_saved_protocol, v_saved_version, v_number
    from save_protocol(v_protocol, p_base_version_id, p_title, p_body, p_note) s;
    perform link_protocol_file(v_protocol, v_sha, 'Talk-through');
  end if;
  perform mark_talk_through_used(p_id, v_saved_version);
  return query select v_saved_protocol, v_saved_version, v_number;
end
$$;

revoke all on talk_throughs from anon, authenticated;
revoke all on function
  audio_max_bytes(),
  record_file(uuid, text, bigint, bigint, text, text, text, date, timestamptz),
  record_talk_through(uuid, text, bigint, text, date, timestamptz, protocol_kind, uuid, uuid, int),
  talk_through(uuid), open_talk_throughs(uuid, uuid), retry_talk_through(uuid),
  mark_talk_through_used(uuid, uuid), use_talk_through(uuid, protocol_kind, uuid, text, text, text)
from public, anon, authenticated;
grant select on talk_throughs to authenticated;
grant execute on function
  audio_max_bytes(),
  record_talk_through(uuid, text, bigint, text, date, timestamptz, protocol_kind, uuid, uuid, int),
  talk_through(uuid), open_talk_throughs(uuid, uuid), retry_talk_through(uuid),
  mark_talk_through_used(uuid, uuid), use_talk_through(uuid, protocol_kind, uuid, text, text, text)
to authenticated;
