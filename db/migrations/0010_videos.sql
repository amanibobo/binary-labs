-- Procedure videos on protocol pages (decisions.md, "procedure videos"). A video is a protocol
-- file whose blob is a video. One added from a phone goes straight to the object store at
-- <lab_id>/files/<sha256>, is recorded like any upload, and waits in pending_protocol_files
-- until the worker has read its bytes and checked their hash; only then is it linked, because
-- a sha256 nobody has verified must never stand for a file. A video linked to a page is
-- transcribed, and its transcript is an extraction like a talk-through's.

-- A new enum value can't be used in the transaction that adds it, so no parsed SQL below
-- names 'video'; 0011 moves video blobs indexed before this migration over to it.
alter type file_kind add value if not exists 'video';

-- About 3 to 5 minutes from a phone camera at 1080p. The bytes go straight to the store in
-- parts, so the cap is set by bench Wi-Fi (13 minutes at 5 Mbps) and not by our server.
create function video_max_bytes() returns bigint
language sql immutable parallel safe as $$ select 500::bigint * 1024 * 1024 $$;

-- A video someone added to a page, waiting for the worker to verify its bytes. The worker
-- links it as the person who added it (so their membership is checked and the audit log
-- names them) and deletes the row.
create table pending_protocol_files (
  protocol_id uuid not null,
  lab_id uuid not null,
  location_id uuid not null references file_locations (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  primary key (protocol_id, location_id),
  foreign key (protocol_id, lab_id) references protocols (id, lab_id) on delete cascade
);
create index pending_protocol_files_location_idx on pending_protocol_files (location_id);

alter table pending_protocol_files enable row level security;
create policy pending_protocol_files_select on pending_protocol_files for select using (is_lab_member(lab_id));
create policy pending_protocol_files_delete on pending_protocol_files for delete using (is_lab_member(lab_id));

-- How far transcribing a lab's video has got. "failed" may work on a retry (the transcriber
-- couldn't be reached); "unavailable" won't (no sound, too long, or no ffmpeg on the worker).
create type video_transcript as enum ('waiting', 'ready', 'failed', 'unavailable');

-- One row per video a lab has linked to a page, written by the worker.
create table videos (
  lab_id uuid not null references labs (id) on delete cascade,
  sha256 text not null references blobs (sha256),
  transcript video_transcript not null default 'waiting',
  transcript_error text check (transcript_error is null or length(transcript_error) <= 500),
  updated_at timestamptz not null default now(),
  primary key (lab_id, sha256),
  check ((transcript in ('failed', 'unavailable')) = (transcript_error is not null))
);

alter table videos enable row level security;
create policy videos_select on videos for select using (is_lab_member(lab_id));

-- Records a video whose bytes are already in the object store and adds it to a page: at once
-- if this lab already holds the same verified bytes, otherwise once the worker has read them.
-- Idempotent like record_upload. Error codes: BL201 too large, BL102 the page is archived,
-- BL103 no such page, 22023 a bad argument.
create function record_video(
  p_lab_id uuid,
  p_sha256 text,
  p_size bigint,
  p_name text,
  p_uploaded_on date,
  p_modified_at timestamptz,
  p_protocol_id uuid
) returns table (location_id uuid, duplicate boolean, linked boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_archived timestamptz;
  v_location uuid;
  v_duplicate boolean;
  v_sha text;
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  select p.archived_at into v_archived from protocols p where p.id = p_protocol_id and p.lab_id = p_lab_id;
  if not found then
    raise exception 'no such protocol' using errcode = 'BL103';
  end if;
  if v_archived is not null then
    raise exception 'this page is archived' using errcode = 'BL102';
  end if;

  select r.location_id, r.duplicate into v_location, v_duplicate
  from record_file(
    p_lab_id, p_sha256, p_size, video_max_bytes(), p_name, null, 'Videos', p_uploaded_on, p_modified_at
  ) r;

  -- Set only by the worker, after it hashed the stored bytes.
  select fl.sha256 into v_sha from file_locations fl where fl.id = v_location;
  if v_sha is not null then
    perform link_protocol_file(p_protocol_id, v_sha, null);
    linked := true;
  else
    insert into pending_protocol_files (protocol_id, lab_id, location_id, requested_by)
    values (p_protocol_id, p_lab_id, v_location, auth.uid())
    on conflict do nothing;
    linked := false;
  end if;
  location_id := v_location;
  duplicate := v_duplicate;
  return next;
end
$$;

-- A page's videos as the page shows them: linked ones that play, then ones still on their way
-- (state 'preparing', or 'failed' when the worker couldn't read the bytes). Transcripts are
-- extractions, closed to members, so this is security definer and checks membership itself.
create function protocol_videos(p_protocol_id uuid)
returns table (
  state text,
  location_id uuid,
  sha256 text,
  name text,
  path text,
  source_kind source_kind,
  mime text,
  size bigint,
  has_poster boolean,
  error text,
  transcript video_transcript,
  transcript_error text,
  transcript_text text,
  added_at timestamptz
)
language sql stable security definer set search_path = public as $$
  with page as (
    select p.id, p.lab_id from protocols p where p.id = p_protocol_id and is_lab_member(p.lab_id)
  ),
  linked as (
    select 0 as grp, pf.ord::bigint as ord, 'ready'::text as state, loc.id as location_id, b.sha256,
      loc.original_name as name, loc.path, loc.kind as source_kind, b.mime, b.size,
      exists (select 1 from previews pr where pr.lab_id = page.lab_id and pr.sha256 = b.sha256) as has_poster,
      null::text as error,
      coalesce(v.transcript, 'waiting') as transcript, v.transcript_error,
      case when v.transcript::text = 'ready' then (
        select e.content from extractions e
        where e.sha256 = b.sha256 and e.kind::text = 'transcript'
        order by e.created_at desc limit 1
      ) end as transcript_text,
      null::timestamptz as added_at
    from page
    join protocol_files pf on pf.protocol_id = page.id
    join blobs b on b.sha256 = pf.sha256 and b.file_kind::text = 'video'
    -- A file we hold plays from our store; otherwise the first Dropbox place it lives.
    join lateral (
      select fl.id, fl.original_name, fl.path, s.kind from file_locations fl join sources s on s.id = fl.source_id
      where fl.lab_id = page.lab_id and fl.sha256 = b.sha256 and fl.deleted_at is null
      order by s.kind::text = 'upload' desc, fl.path, fl.id limit 1
    ) loc on true
    left join videos v on v.lab_id = page.lab_id and v.sha256 = b.sha256
  ),
  pending as (
    select 1 as grp, row_number() over (order by pp.requested_at, fl.id) as ord,
      case when fl.index_state = 'failed' then 'failed' else 'preparing' end as state,
      fl.id as location_id, null::text as sha256, fl.original_name as name, fl.path, s.kind as source_kind,
      null::text as mime, fl.size, false as has_poster, fl.index_error as error,
      null::video_transcript as transcript, null::text as transcript_error, null::text as transcript_text,
      pp.requested_at as added_at
    from page
    join pending_protocol_files pp on pp.protocol_id = page.id
    join file_locations fl on fl.id = pp.location_id and fl.deleted_at is null
    join sources s on s.id = fl.source_id
  )
  select state, location_id, sha256, name, path, source_kind, mime, size, has_poster, error,
    transcript, transcript_error, transcript_text, added_at
  from (select * from linked union all select * from pending) r
  order by grp, ord, location_id
$$;

-- Sends a failed transcription round again.
create function retry_video_transcript(p_lab_id uuid, p_sha256 text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  update videos set transcript = 'waiting', transcript_error = null, updated_at = now()
  where lab_id = p_lab_id and sha256 = p_sha256 and transcript = 'failed';
end
$$;

revoke all on pending_protocol_files, videos from anon, authenticated;
revoke all on function
  video_max_bytes(),
  record_video(uuid, text, bigint, text, date, timestamptz, uuid),
  protocol_videos(uuid),
  retry_video_transcript(uuid, text)
from public, anon, authenticated;
grant select, delete on pending_protocol_files to authenticated;
grant select on videos to authenticated;
grant execute on function
  video_max_bytes(),
  record_video(uuid, text, bigint, text, date, timestamptz, uuid),
  protocol_videos(uuid),
  retry_video_transcript(uuid, text)
to authenticated;
