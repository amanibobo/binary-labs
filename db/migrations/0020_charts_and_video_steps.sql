-- The rest of charts and videos (decisions.md, "dates along x", "per-series x columns", "plate
-- heatmaps", "more than six series", "re-parsing tables" and "steps from a video").

-- Chart specs, mirroring ChartSpec in apps/web/src/lib/charts.ts. An x/y chart's series may
-- name a stroke (a line chart's second six are dashed) and its own x column; old specs have
-- neither and keep the shared x and a solid line. Lines take 12 series, bars 6, a scatter 3. A
-- plate heatmap names its size and where its wells are read from. The check constraint on
-- charts.spec calls this function, so new writes are checked against it; rows already saved
-- passed the old one, which this one accepts too.
create or replace function chart_spec_ok(s jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(s) = 'object'
    and length(s::text) <= 16000
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
      else false
    end,
    false
  )
$$;

-- Re-parsing after a parser version bump (decisions.md, "re-parsing tables"). The worker's
-- sweep reads stale tables again, those used longest ago first; one a newer parser couldn't
-- read keeps its old table, and the row records which version tried and why, so the sweep
-- moves on and doesn't try that version again. The stale rows are found by this index.
alter table data_tables
  add column reparse_version int,
  add column reparse_error text check (reparse_error is null or length(reparse_error) <= 500),
  add constraint data_tables_reparse_check check ((reparse_version is null) = (reparse_error is null));
create index data_tables_parser_idx on data_tables (parser_version) where state in ('ready', 'failed');

-- Steps from a video (decisions.md, "steps from a video"). A talk-through drafts steps from
-- something said: a recording made for it (location_id), or a video already on a protocol's
-- page (video_sha256), whose transcript the worker makes anyway. A video's talk-through is
-- always against the page's version at the time it was asked for, and waits for the video's
-- transcript before drafting. A draft can be dismissed; nothing applies itself.
alter table talk_throughs
  alter column location_id drop not null,
  add column video_sha256 text references blobs (sha256),
  add column dismissed_at timestamptz,
  add constraint talk_throughs_source_check check ((location_id is null) <> (video_sha256 is null)),
  add constraint talk_throughs_video_page_check check (video_sha256 is null or protocol_id is not null),
  add constraint talk_throughs_dismissed_check check (dismissed_at is null or used_version_id is null);
-- One open draft per video and page: asking again returns it.
create unique index talk_throughs_open_video_idx on talk_throughs (protocol_id, video_sha256)
  where video_sha256 is not null and used_version_id is null and dismissed_at is null;
create index talk_throughs_video_idx on talk_throughs (lab_id, video_sha256) where video_sha256 is not null;

-- How far a video's transcript has got, as a recording's index_state: a talk-through on either
-- reads the same way. A missing videos row is a video the worker hasn't seen yet.
create function video_index_state(p_lab_id uuid, p_sha256 text) returns index_state
language sql stable security definer set search_path = public as $$
  select case coalesce((select v.transcript::text from videos v where v.lab_id = p_lab_id and v.sha256 = p_sha256), 'waiting')
    when 'waiting' then 'pending'::index_state
    when 'failed' then 'failed'::index_state
    else 'indexed'::index_state
  end
$$;

-- "Draft steps from this video": the open draft for this video on this page, or a new one
-- against the page's current version. Error codes: BL102 the page is archived, BL103 no such
-- page, BL104 the video isn't on the page.
create function start_video_steps(p_protocol_id uuid, p_sha256 text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_lab uuid;
  v_kind protocol_kind;
  v_version uuid;
  v_archived timestamptz;
  v_id uuid;
begin
  select p.lab_id, p.kind, p.current_version_id, p.archived_at into v_lab, v_kind, v_version, v_archived
  from protocols p where p.id = p_protocol_id;
  if not found or auth.uid() is null or not is_lab_member(v_lab) then
    raise exception 'no such protocol' using errcode = 'BL103';
  end if;
  if v_archived is not null then
    raise exception 'this page is archived' using errcode = 'BL102';
  end if;
  if not exists (
    select 1 from protocol_files pf join blobs b on b.sha256 = pf.sha256
    where pf.protocol_id = p_protocol_id and pf.sha256 = p_sha256 and b.file_kind::text = 'video'
  ) then
    raise exception 'that video is not on this page' using errcode = 'BL104';
  end if;
  insert into talk_throughs (lab_id, video_sha256, kind, protocol_id, base_version_id, recorded_by)
  values (v_lab, p_sha256, v_kind, p_protocol_id, v_version, auth.uid())
  on conflict (protocol_id, video_sha256)
    where video_sha256 is not null and used_version_id is null and dismissed_at is null
    do nothing
  returning id into v_id;
  if v_id is null then
    select t.id into v_id from talk_throughs t
    where t.protocol_id = p_protocol_id and t.video_sha256 = p_sha256
      and t.used_version_id is null and t.dismissed_at is null;
  end if;
  return v_id;
end
$$;

-- Puts a draft aside without using it. A dismissed draft stays readable, and asking for steps
-- from the same video again starts a new one.
create function dismiss_talk_through(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update talk_throughs t set dismissed_at = now()
  where t.id = p_id and is_lab_member(t.lab_id) and t.used_version_id is null and t.dismissed_at is null;
  if not found and not exists (select 1 from talk_throughs t where t.id = p_id and is_lab_member(t.lab_id)) then
    raise exception 'no such talk-through' using errcode = 'BL103';
  end if;
end
$$;

-- A talk-through as its page shows it, now for a recording or a video: where what was said is
-- (location_id plays it), how far its transcript has got, the draft, and the page's current
-- version to read the draft against.
drop function talk_through(uuid);
create function talk_through(p_id uuid)
returns table (
  id uuid,
  kind protocol_kind,
  source text,
  protocol_id uuid,
  protocol_title text,
  base_version_id uuid,
  base_version int,
  current_version int,
  current_body text,
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
  dismissed_at timestamptz,
  used_protocol_id uuid,
  used_version int
)
language sql stable security definer set search_path = public as $$
  select t.id, t.kind,
    case when t.video_sha256 is null then 'recording' else 'video' end,
    t.protocol_id, cv.title, t.base_version_id, bv.version, cv.version, cv.body,
    t.recorded_by, t.recorded_at, t.duration_ms,
    m.location_id, m.sha256, m.name, m.index_state, m.index_error,
    tr.content,
    t.draft, t.draft_title, t.draft_body, t.draft_error, t.dismissed_at,
    uv.protocol_id, uv.version
  from talk_throughs t
  left join protocols p on p.id = t.protocol_id
  left join protocol_versions cv on cv.id = p.current_version_id
  left join protocol_versions bv on bv.id = t.base_version_id
  left join protocol_versions uv on uv.id = t.used_version_id
  -- What was said: the recording itself, or the video's place in the lab (our copy first).
  join lateral (
    select fl.id as location_id, fl.sha256, fl.original_name as name, fl.index_state, fl.index_error
    from file_locations fl where fl.id = t.location_id and fl.deleted_at is null
    union all
    select loc.id, t.video_sha256, loc.original_name, video_index_state(t.lab_id, t.video_sha256),
      (select v.transcript_error from videos v where v.lab_id = t.lab_id and v.sha256 = t.video_sha256)
    from (
      select fl.id, fl.original_name from file_locations fl join sources s on s.id = fl.source_id
      where t.video_sha256 is not null and fl.lab_id = t.lab_id and fl.sha256 = t.video_sha256
        and fl.deleted_at is null
      order by s.kind::text = 'upload' desc, fl.path, fl.id limit 1
    ) loc
  ) m on true
  left join lateral (
    select e.content from extractions e
    where e.sha256 = m.sha256 and e.kind::text = 'transcript'
    order by e.created_at desc limit 1
  ) tr on true
  where t.id = p_id and is_lab_member(t.lab_id)
$$;

-- Talk-throughs nobody has used or dismissed: a page's (recordings and videos), or with no
-- page, the caller's own new-page ones.
create or replace function open_talk_throughs(p_lab_id uuid, p_protocol_id uuid default null)
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
  select t.id, t.kind, t.recorded_by, t.recorded_at, t.duration_ms,
    coalesce(fl.index_state, video_index_state(t.lab_id, t.video_sha256)), t.draft, t.draft_title
  from talk_throughs t
  left join file_locations fl on fl.id = t.location_id
  where t.lab_id = p_lab_id and t.used_version_id is null and t.dismissed_at is null
    and (fl.id is null) = (t.location_id is null) and (fl.deleted_at is null)
    and (case when p_protocol_id is null then t.protocol_id is null and t.recorded_by = auth.uid()
         else t.protocol_id = p_protocol_id end)
  order by t.recorded_at desc, t.id
  limit 20
$$;

-- Sends a failed transcription or a failed draft round again: a recording's, or a video's
-- transcript, which the video's own Try again does too.
create or replace function retry_talk_through(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_lab uuid;
  v_location uuid;
  v_video text;
  v_source uuid;
begin
  select t.lab_id, t.location_id, t.video_sha256 into v_lab, v_location, v_video from talk_throughs t where t.id = p_id;
  if not found or not is_lab_member(v_lab) then
    raise exception 'no such talk-through' using errcode = 'BL103';
  end if;
  update file_locations fl set index_state = 'pending', index_error = null
  where fl.id = v_location and fl.index_state = 'failed'
  returning fl.source_id into v_source;
  if v_source is not null then
    update sources set scan_requested_at = clock_timestamp() where id = v_source;
  end if;
  update videos set transcript = 'waiting', transcript_error = null, updated_at = now()
  where lab_id = v_lab and sha256 = v_video and transcript = 'failed';
  update talk_throughs t set draft = 'waiting', draft_error = null where t.id = p_id and t.draft = 'failed';
end
$$;

-- "Use these steps", now for a video's draft too, whose video is already on the page. A
-- dismissed draft is put aside, not used (BL105 as for one already used).
create or replace function use_talk_through(
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
  v_dismissed timestamptz;
  v_video text;
  v_sha text;
  v_saved_protocol uuid;
  v_saved_version uuid;
  v_number int;
begin
  select t.lab_id, t.protocol_id, t.used_version_id, t.dismissed_at, t.video_sha256, coalesce(t.video_sha256, fl.sha256)
  into v_lab, v_protocol, v_used, v_dismissed, v_video, v_sha
  from talk_throughs t left join file_locations fl on fl.id = t.location_id
  where t.id = p_id;
  if not found then
    raise exception 'no such talk-through' using errcode = 'BL103';
  end if;
  if v_used is not null or v_dismissed is not null then
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
    if v_video is null then
      perform link_protocol_file(v_protocol, v_sha, 'Talk-through');
    end if;
  end if;
  perform mark_talk_through_used(p_id, v_saved_version);
  return query select v_saved_protocol, v_saved_version, v_number;
end
$$;

revoke all on function
  video_index_state(uuid, text), start_video_steps(uuid, text), dismiss_talk_through(uuid), talk_through(uuid)
from public, anon, authenticated;
grant execute on function
  video_index_state(uuid, text), start_video_steps(uuid, text), dismiss_talk_through(uuid), talk_through(uuid)
to authenticated;
