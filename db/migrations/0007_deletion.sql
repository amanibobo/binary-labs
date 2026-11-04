-- Deleting a lab and disconnecting Dropbox (decisions.md, 2026-11-04).
--
-- A lab marked for deletion is gone for everyone at once: membership checks treat it as
-- missing, so every RLS policy hides its rows. The worker's delete_lab job then removes its
-- previews, the lab row (every lab-scoped row cascades) and the blobs and extractions no
-- other lab references, and stamps the lab_deletions row, which is all we keep.

-- A new enum value can't be used in the transaction that adds it. Only plpgsql bodies,
-- which aren't checked until they run, name these.
alter type audit_action add value if not exists 'source.disconnect';
alter type audit_action add value if not exists 'lab.delete';
alter type audit_action add value if not exists 'protocol.export';

alter table labs add column deletion_requested_at timestamptz;

-- A Dropbox source either holds a token or was disconnected; a local one has neither.
alter table sources add column disconnected_at timestamptz;
alter table sources drop constraint sources_check;
alter table sources add constraint sources_token_check check (
  case kind
    when 'dropbox' then (token_ciphertext is null) = (disconnected_at is not null)
    else token_ciphertext is null and disconnected_at is null
  end
);

-- The proof a deletion happened, without anything about the lab: no foreign key, since
-- the lab row is gone once completed_at is set.
create table lab_deletions (
  lab_id uuid primary key,
  requested_by uuid references auth.users (id) on delete set null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  counts jsonb not null default '{}' check (jsonb_typeof(counts) = 'object')
);
create index lab_deletions_pending_idx on lab_deletions (requested_at) where completed_at is null;

-- Deleting a blob checks every table that points at it; these keep each check an index lookup.
create index file_locations_sha_idx on file_locations (sha256);
create index chunks_sha_idx on chunks (sha256);
create index previews_sha_idx on previews (sha256);
create index labels_sha_idx on labels (sha256);
create index model_calls_sha_idx on model_calls (sha256);
create index protocol_files_sha_idx on protocol_files (sha256);

create or replace function is_lab_member(p_lab_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members m join labs l on l.id = m.lab_id
    where m.lab_id = p_lab_id and m.user_id = auth.uid() and l.deletion_requested_at is null
  )
$$;

create or replace function is_lab_admin(p_lab_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members m join labs l on l.id = m.lab_id
    where m.lab_id = p_lab_id and m.user_id = auth.uid() and m.role = 'admin'
      and l.deletion_requested_at is null
  )
$$;

alter table lab_deletions enable row level security;

-- The person who deleted a lab can see how the removal went; nobody else can.
create policy lab_deletions_select on lab_deletions for select using (requested_by = auth.uid());
-- Only deletion_requested_at is granted, and the trigger below makes it one way.
create policy labs_update on labs for update using (is_lab_admin(id)) with check (true);

-- Errors a person can cause carry their own codes: BL201 the typed name doesn't match,
-- BL202 no such lab (or not yours to see), BL203 no such source.

-- Marking a lab for deletion is one way and does everything that must happen at once:
-- tokens go, scans stop, and the durable record is written.
create function labs_request_deletion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.deletion_requested_at is not null or new.deletion_requested_at is null then
    raise exception 'this lab is already being deleted' using errcode = 'BL202';
  end if;
  new.deletion_requested_at := now();
  update sources set token_ciphertext = null where lab_id = new.id and token_ciphertext is not null;
  update sources set scan_requested_at = null, scan_finished_at = now() where lab_id = new.id;
  insert into lab_deletions (lab_id, requested_by, requested_at)
  values (new.id, auth.uid(), new.deletion_requested_at);
  insert into audit_log (lab_id, actor, action, target) values (new.id, auth.uid(), 'lab.delete', null);
  return new;
end
$$;

create trigger labs_request_deletion before update of deletion_requested_at on labs
  for each row when (new.deletion_requested_at is distinct from old.deletion_requested_at)
  execute function labs_request_deletion();

-- Dropping the token disconnects: the listing cursor goes with it and nothing scans. A new
-- token reconnects, and the next scan lists everything again.
create function sources_token_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind <> 'dropbox' then
    raise exception 'only a Dropbox source holds a token' using errcode = '22023';
  end if;
  new.cursor := null;
  new.scan_error := null;
  if new.token_ciphertext is null then
    new.disconnected_at := now();
    new.scan_requested_at := null;
    insert into audit_log (lab_id, actor, action, target)
    values (new.lab_id, auth.uid(), 'source.disconnect', new.id::text);
  elsif old.token_ciphertext is null then
    new.disconnected_at := null;
    new.scan_requested_at := case when new.root_path is not null then now() end;
  end if;
  return new;
end
$$;

create trigger sources_token_change before update of token_ciphertext on sources
  for each row when (new.token_ciphertext is distinct from old.token_ciphertext)
  execute function sources_token_change();

create function request_lab_deletion(p_lab_id uuid, p_confirm_name text) returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_name text;
begin
  select l.name into v_name from labs l where l.id = p_lab_id;
  if not found then
    raise exception 'no such lab' using errcode = 'BL202';
  end if;
  if not is_lab_admin(p_lab_id) then
    raise exception 'only admins can delete a lab' using errcode = '42501';
  end if;
  if btrim(coalesce(p_confirm_name, '')) <> v_name then
    raise exception 'the name doesn''t match' using errcode = 'BL201';
  end if;
  update labs set deletion_requested_at = now() where id = p_lab_id;
end
$$;

-- Safe to repeat: an already disconnected source stays as it is.
create function disconnect_source(p_source_id uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare
  s record;
begin
  select src.lab_id, src.kind, src.disconnected_at into s from sources src where src.id = p_source_id;
  if not found then
    raise exception 'no such source' using errcode = 'BL203';
  end if;
  if not is_lab_admin(s.lab_id) then
    raise exception 'only admins can disconnect Dropbox' using errcode = '42501';
  end if;
  if s.kind <> 'dropbox' then
    raise exception 'only a Dropbox source can be disconnected' using errcode = '22023';
  end if;
  if s.disconnected_at is null then
    update sources set token_ciphertext = null where id = p_source_id;
  end if;
end
$$;

-- Every live page's current version, for the download offered before deleting a lab.
create function protocol_export(p_lab_id uuid)
returns table (id uuid, kind protocol_kind, title text, version int, body text, updated_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select p.id, p.kind, v.title, v.version, v.body, v.created_at
  from protocols p
  join protocol_versions v on v.id = p.current_version_id
  where p.lab_id = p_lab_id and p.archived_at is null
  order by p.kind, lower(v.title), p.id
$$;

revoke all on lab_deletions from anon, authenticated;
revoke all on function
  labs_request_deletion(), sources_token_change(), request_lab_deletion(uuid, text),
  disconnect_source(uuid), protocol_export(uuid)
from public, anon, authenticated;

grant select on lab_deletions to authenticated;
grant update (deletion_requested_at) on labs to authenticated;
grant select (disconnected_at) on sources to authenticated;
grant update (token_ciphertext, account_label) on sources to authenticated;
grant execute on function request_lab_deletion(uuid, text), disconnect_source(uuid), protocol_export(uuid)
  to authenticated;
