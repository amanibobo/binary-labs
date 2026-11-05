-- Instruments (decisions.md, "Phase 3 starts with the parts that don't need the pilot lab").
-- An admin adds an instrument and gets a one-time pairing code; the uploader on the instrument
-- PC trades the code for a device token that can only add files to that instrument's own
-- source. Codes and tokens are stored as sha256 hashes, never as themselves. The bytes go to
-- the object store at <lab_id>/files/<sha256> like uploads; a file is a file_locations row on
-- the instrument's source whose external_id is its path on the instrument PC and whose
-- source_rev is its sha256, so a file the instrument rewrites in place is one location.

-- A new enum value can't be used in the transaction that adds it, so no parsed SQL below
-- names 'instrument'; plpgsql bodies are only checked when they run.
alter type source_kind add value if not exists 'instrument';
alter type audit_action add value if not exists 'instrument.create';
alter type audit_action add value if not exists 'instrument.pair';
alter type audit_action add value if not exists 'instrument.revoke';

-- Instrument exports run from a few KB to a few hundred MB. The cap matches videos, because
-- the worker reads a whole file into memory; anything bigger waits for content-defined shards.
create function instrument_max_bytes() returns bigint
language sql immutable parallel safe as $$ select 500::bigint * 1024 * 1024 $$;

create function pairing_minutes() returns int
language sql immutable parallel safe as $$ select 15 $$;

create table instruments (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  source_id uuid not null unique,
  -- Shown in Settings and as the Browse folder Instruments/<name>, so no slashes.
  name text not null check (length(btrim(name)) between 1 and 80 and name = btrim(name) and name !~ '[/\\[:cntrl:]]'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  pairing_code_hash text unique check (pairing_code_hash ~ '^[0-9a-f]{64}$'),
  pairing_expires_at timestamptz,
  paired_at timestamptz,
  token_hash text unique check (token_hash ~ '^[0-9a-f]{64}$'),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  foreign key (source_id, lab_id) references sources (id, lab_id) on delete cascade,
  unique (id, lab_id),
  check ((pairing_code_hash is null) = (pairing_expires_at is null)),
  -- A code pairs once; after that the instrument has a token until it's revoked.
  check (paired_at is null or pairing_code_hash is null),
  check ((token_hash is not null) = (paired_at is not null and revoked_at is null)),
  check (revoked_at is null or pairing_code_hash is null)
);
create unique index instruments_live_name_idx on instruments (lab_id, lower(name)) where revoked_at is null;

alter table instruments enable row level security;
create policy instruments_select on instruments for select using (is_lab_member(lab_id));

-- Failed pairing tries, so a guesser runs out of tries long before codes run out. Not lab
-- data: a hash of the caller's address and when, kept an hour.
create table instrument_pair_attempts (
  client text not null,
  at timestamptz not null default now()
);
create index instrument_pair_attempts_client_idx on instrument_pair_attempts (client, at);
create index instrument_pair_attempts_at_idx on instrument_pair_attempts (at);
alter table instrument_pair_attempts enable row level security;

create function check_instrument_name(p_name text) returns text
language plpgsql immutable as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if v_name = '' or length(v_name) > 80 then
    raise exception 'an instrument needs a name of up to 80 characters' using errcode = '22023';
  end if;
  if v_name ~ '[/\\[:cntrl:]]' then
    raise exception 'an instrument name can''t have a slash in it' using errcode = '22023';
  end if;
  return v_name;
end
$$;

-- Adds an instrument with its own source and a pairing code good for 15 minutes. The web app
-- makes the code and sends only its hash. Error codes: BL301 the name is taken, 22023 a bad
-- argument, 42501 not an admin.
create function create_instrument(p_lab_id uuid, p_name text, p_code_hash text)
returns table (instrument_id uuid, pairing_expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_name text := check_instrument_name(p_name);
  v_source uuid;
  v_id uuid;
  v_expires timestamptz := now() + make_interval(mins => pairing_minutes());
begin
  if auth.uid() is null or not is_lab_admin(p_lab_id) then
    raise exception 'only admins can add an instrument' using errcode = '42501';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'the code hash must be sha256 hex' using errcode = '22023';
  end if;
  if exists (select 1 from instruments i where i.lab_id = p_lab_id and lower(i.name) = lower(v_name) and i.revoked_at is null) then
    raise exception 'an instrument is already called %', v_name using errcode = 'BL301';
  end if;
  insert into sources (lab_id, kind, root_path) values (p_lab_id, 'instrument', '/') returning id into v_source;
  insert into instruments (lab_id, source_id, name, created_by, pairing_code_hash, pairing_expires_at)
  values (p_lab_id, v_source, v_name, auth.uid(), p_code_hash, v_expires)
  returning id into v_id;
  insert into audit_log (lab_id, actor, action, target) values (p_lab_id, auth.uid(), 'instrument.create', v_id::text);
  instrument_id := v_id;
  pairing_expires_at := v_expires;
  return next;
end
$$;

-- A fresh code for an instrument that hasn't paired yet, when the last one ran out.
-- Error codes: BL302 already paired or revoked, BL303 no such instrument.
create function renew_pairing_code(p_instrument_id uuid, p_code_hash text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v record;
  v_expires timestamptz := now() + make_interval(mins => pairing_minutes());
begin
  select i.lab_id, i.paired_at, i.revoked_at into v from instruments i where i.id = p_instrument_id for update;
  if not found or not is_lab_member(v.lab_id) then
    raise exception 'no such instrument' using errcode = 'BL303';
  end if;
  if not is_lab_admin(v.lab_id) then
    raise exception 'only admins can pair an instrument' using errcode = '42501';
  end if;
  if v.paired_at is not null or v.revoked_at is not null then
    raise exception 'this instrument is already paired or revoked' using errcode = 'BL302';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'the code hash must be sha256 hex' using errcode = '22023';
  end if;
  update instruments set pairing_code_hash = p_code_hash, pairing_expires_at = v_expires where id = p_instrument_id;
  return v_expires;
end
$$;

-- Stops an instrument's token and any code at once. Its files stay. Safe to repeat.
create function revoke_instrument(p_instrument_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v record;
begin
  select i.lab_id, i.revoked_at into v from instruments i where i.id = p_instrument_id for update;
  if not found or not is_lab_member(v.lab_id) then
    raise exception 'no such instrument' using errcode = 'BL303';
  end if;
  if not is_lab_admin(v.lab_id) then
    raise exception 'only admins can revoke an instrument' using errcode = '42501';
  end if;
  if v.revoked_at is null then
    update instruments
    set revoked_at = now(), token_hash = null, pairing_code_hash = null, pairing_expires_at = null
    where id = p_instrument_id;
    insert into audit_log (lab_id, actor, action, target) values (v.lab_id, auth.uid(), 'instrument.revoke', p_instrument_id::text);
  end if;
end
$$;

-- Settings' list: every instrument, live ones first, with how many files it has sent.
create function lab_instruments(p_lab_id uuid)
returns table (
  id uuid,
  name text,
  state text,
  pairing_expires_at timestamptz,
  paired_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz,
  files bigint
)
language sql stable security invoker set search_path = public as $$
  select i.id, i.name,
    case
      when i.revoked_at is not null then 'revoked'
      when i.paired_at is not null then 'paired'
      when i.pairing_expires_at > now() then 'waiting'
      else 'expired'
    end,
    i.pairing_expires_at, i.paired_at, i.last_seen_at, i.revoked_at, i.created_at,
    (select count(*) from file_locations fl where fl.source_id = i.source_id and fl.deleted_at is null)
  from instruments i
  where i.lab_id = p_lab_id
  order by i.revoked_at is not null, i.created_at, i.id
$$;

-- The uploader's side. Only the web server calls these, as the service role, because pairing
-- has no session and its rate limit trusts the caller's address the server passes in.

-- Trades a code for a device token. Answers 'paired', 'refused' (wrong, expired or used, all
-- alike) or 'limited'; it returns instead of raising so a refused try is still counted.
create function pair_instrument(p_code_hash text, p_token_hash text, p_client text)
returns table (outcome text, paired_id uuid, paired_name text, paired_lab_name text)
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_name text;
  v_lab uuid;
  v_lab_name text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'the token hash must be sha256 hex' using errcode = '22023';
  end if;
  delete from instrument_pair_attempts a where a.at < now() - interval '1 hour';
  if (select count(*) from instrument_pair_attempts a where a.client = p_client and a.at > now() - interval '15 minutes') >= 10
    or (select count(*) from instrument_pair_attempts a where a.at > now() - interval '15 minutes') >= 1000 then
    outcome := 'limited';
    return next;
    return;
  end if;
  update instruments i
  set token_hash = p_token_hash, paired_at = now(), last_seen_at = now(),
    pairing_code_hash = null, pairing_expires_at = null
  from labs l
  where i.pairing_code_hash = p_code_hash and i.pairing_expires_at > now()
    and i.paired_at is null and i.revoked_at is null
    and l.id = i.lab_id and l.deletion_requested_at is null
  returning i.id, i.name, i.lab_id, l.name into v_id, v_name, v_lab, v_lab_name;
  if v_id is null then
    insert into instrument_pair_attempts (client) values (coalesce(p_client, ''));
    outcome := 'refused';
    return next;
    return;
  end if;
  insert into audit_log (lab_id, actor, action, target) values (v_lab, null, 'instrument.pair', v_id::text);
  outcome := 'paired';
  paired_id := v_id;
  paired_name := v_name;
  paired_lab_name := v_lab_name;
  return next;
end
$$;

-- The instrument a token belongs to, while it's live. Notes when it was last seen, at most
-- every 30 s so a busy uploader doesn't write a row per request.
create function instrument_session(p_token_hash text)
returns table (instrument_id uuid, lab_id uuid, source_id uuid, name text)
language plpgsql security definer set search_path = public as $$
begin
  return query
  update instruments i set last_seen_at = case
      when i.last_seen_at is null or i.last_seen_at < now() - interval '30 seconds' then now()
      else i.last_seen_at end
  from labs l
  where i.token_hash = p_token_hash and i.revoked_at is null
    and l.id = i.lab_id and l.deletion_requested_at is null
  returning i.id, i.lab_id, i.source_id, i.name;
end
$$;

-- Records a file whose verified bytes are in the object store at <lab_id>/files/<sha256>, at
-- its path on the instrument PC, on the token's own source and nowhere else. The same bytes at
-- the same path again are a duplicate; new bytes at a known path go back to pending. Error
-- codes: 28000 the token isn't live, BL201 too large, 22023 a bad argument.
create function record_instrument_file(
  p_token_hash text,
  p_path text,
  p_sha256 text,
  p_size bigint,
  p_modified_at timestamptz
) returns table (location_id uuid, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  v record;
  v_existing record;
  v_location uuid;
  v_modified timestamptz := case
    when p_modified_at between '1990-01-01' and now() + interval '1 day' then p_modified_at else now() end;
begin
  select i.lab_id, i.source_id, i.name into v
  from instruments i join labs l on l.id = i.lab_id
  where i.token_hash = p_token_hash and i.revoked_at is null and l.deletion_requested_at is null;
  if not found then
    raise exception 'this uploader isn''t paired' using errcode = '28000';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'sha256 must be lowercase hex' using errcode = '22023';
  end if;
  if p_size is null or p_size < 0 then
    raise exception 'size must be a byte count' using errcode = '22023';
  end if;
  if p_size > instrument_max_bytes() then
    raise exception 'file is larger than % bytes', instrument_max_bytes() using errcode = 'BL201';
  end if;
  if p_path is null or length(p_path) > 1000 or p_path !~ '^[^/]+(/[^/]+)*$' or p_path ~ '[\\[:cntrl:]]'
    or p_path ~ '(^|/)\.\.?(/|$)' then
    raise exception 'a path is folder/name with forward slashes' using errcode = '22023';
  end if;

  select fl.id, fl.source_rev, fl.deleted_at, fl.index_state into v_existing
  from file_locations fl where fl.source_id = v.source_id and fl.external_id = p_path for update;

  if found and v_existing.source_rev = p_sha256 and v_existing.deleted_at is null then
    update file_locations fl set seen_at = now(), index_state = 'pending', index_error = null
    where fl.id = v_existing.id and fl.index_state = 'failed';
    location_id := v_existing.id;
    duplicate := true;
  else
    insert into file_locations as fl
      (lab_id, source_id, external_id, path, original_name, size, modified_at, source_rev)
    values (
      v.lab_id, v.source_id, p_path, '/Instruments/' || v.name || '/' || p_path,
      regexp_replace(p_path, '^.*/', ''), p_size, v_modified, p_sha256
    )
    on conflict (source_id, external_id) do update set
      path = excluded.path,
      size = excluded.size,
      modified_at = excluded.modified_at,
      source_rev = excluded.source_rev,
      seen_at = now(),
      deleted_at = null,
      index_state = 'pending',
      index_error = null
    returning fl.id into v_location;
    location_id := v_location;
    duplicate := false;
  end if;

  -- clock_timestamp, not now(): a scan that started while this transaction ran must see a
  -- later request and run again.
  update sources set scan_requested_at = clock_timestamp() where id = v.source_id;
  return next;
end
$$;

revoke all on instruments, instrument_pair_attempts from public, anon, authenticated;
revoke all on function
  instrument_max_bytes(), pairing_minutes(), check_instrument_name(text),
  create_instrument(uuid, text, text), renew_pairing_code(uuid, text), revoke_instrument(uuid),
  lab_instruments(uuid), pair_instrument(text, text, text), instrument_session(text),
  record_instrument_file(text, text, text, bigint, timestamptz)
from public, anon, authenticated;

-- Members see instruments but never a code or token hash: a code is short enough to guess
-- from its hash in seconds.
grant select (id, lab_id, source_id, name, created_by, created_at, pairing_expires_at, paired_at, last_seen_at, revoked_at)
  on instruments to authenticated;
grant execute on function
  instrument_max_bytes(), check_instrument_name(text), pairing_minutes(),
  create_instrument(uuid, text, text), renew_pairing_code(uuid, text), revoke_instrument(uuid),
  lab_instruments(uuid)
to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function
      instrument_max_bytes(), check_instrument_name(text),
      pair_instrument(text, text, text), instrument_session(text),
      record_instrument_file(text, text, text, bigint, timestamptz)
    to service_role;
  end if;
end
$$;
