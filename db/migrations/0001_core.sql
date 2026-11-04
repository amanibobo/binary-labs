create extension if not exists vector;

create type member_role as enum ('admin', 'member');
create type source_kind as enum ('dropbox', 'local');
create type file_kind as enum ('pdf', 'spreadsheet', 'document', 'text', 'image', 'other');
create type index_state as enum ('pending', 'indexed', 'failed');
create type extraction_kind as enum ('text', 'table', 'image_meta');
create type audit_action as enum (
  'lab.create', 'source.connect', 'source.set_folder', 'scan.request',
  'member.invite', 'search', 'preview.view'
);

create table labs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  plan text not null default 'pilot',
  created_at timestamptz not null default now()
);

create table members (
  lab_id uuid not null references labs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role member_role not null,
  created_at timestamptz not null default now(),
  primary key (lab_id, user_id)
);
create index members_user_idx on members (user_id);

create table sources (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  kind source_kind not null,
  root_path text,
  account_label text,
  token_ciphertext bytea,
  cursor text,
  scan_requested_at timestamptz,
  scan_started_at timestamptz,
  scan_finished_at timestamptz,
  scan_error text,
  created_at timestamptz not null default now(),
  unique (id, lab_id),
  check (kind <> 'dropbox' or token_ciphertext is not null)
);
create index sources_lab_idx on sources (lab_id);

create table blobs (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint not null check (size >= 0),
  mime text not null,
  file_kind file_kind not null,
  created_at timestamptz not null default now()
);

create table file_locations (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null,
  source_id uuid not null,
  external_id text not null,
  path text not null,
  original_name text not null,
  size bigint not null check (size >= 0),
  modified_at timestamptz not null,
  source_rev text not null,
  sha256 text references blobs (sha256),
  index_state index_state not null default 'pending',
  index_error text,
  indexed_at timestamptz,
  seen_at timestamptz not null default now(),
  deleted_at timestamptz,
  name_tsv tsvector generated always as (
    to_tsvector('english', regexp_replace(path, '[_./\\-]+', ' ', 'g'))
  ) stored,
  foreign key (source_id, lab_id) references sources (id, lab_id) on delete cascade,
  unique (source_id, external_id),
  check (index_state <> 'indexed' or sha256 is not null),
  check ((index_state = 'failed') = (index_error is not null))
);
create index file_locations_lab_sha_idx on file_locations (lab_id, sha256) where deleted_at is null;
create index file_locations_source_state_idx on file_locations (source_id, index_state);
create index file_locations_lab_modified_idx on file_locations (lab_id, modified_at desc) where deleted_at is null;
create index file_locations_name_tsv_idx on file_locations using gin (name_tsv);

create table extractions (
  sha256 text not null references blobs (sha256) on delete cascade,
  extractor text not null,
  extractor_version int not null check (extractor_version > 0),
  kind extraction_kind not null,
  content text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (sha256, extractor, extractor_version)
);

create table chunks (
  lab_id uuid not null references labs (id) on delete cascade,
  sha256 text not null references blobs (sha256),
  ord int not null check (ord >= 0),
  text text not null,
  embedding vector(1024),
  embed_model text,
  tsv tsvector generated always as (to_tsvector('english', text)) stored,
  primary key (lab_id, sha256, ord),
  check ((embedding is null) = (embed_model is null))
);
create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);

create table previews (
  lab_id uuid not null references labs (id) on delete cascade,
  sha256 text not null references blobs (sha256),
  storage_key text not null,
  width int not null check (width > 0),
  height int not null check (height > 0),
  primary key (lab_id, sha256)
);

create table audit_log (
  id bigint generated always as identity primary key,
  lab_id uuid not null references labs (id) on delete cascade,
  actor uuid references auth.users (id) on delete set null,
  action audit_action not null,
  target text,
  at timestamptz not null default now()
);
create index audit_log_lab_at_idx on audit_log (lab_id, at desc);

create function is_lab_member(p_lab_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where lab_id = p_lab_id and user_id = auth.uid())
$$;

create function is_lab_admin(p_lab_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members where lab_id = p_lab_id and user_id = auth.uid() and role = 'admin'
  )
$$;

alter table labs enable row level security;
alter table members enable row level security;
alter table sources enable row level security;
alter table blobs enable row level security;
alter table file_locations enable row level security;
alter table extractions enable row level security;
alter table chunks enable row level security;
alter table previews enable row level security;
alter table audit_log enable row level security;

create policy labs_select on labs for select using (is_lab_member(id));

create policy members_select on members for select using (is_lab_member(lab_id));
create policy members_delete on members for delete using (is_lab_admin(lab_id) and user_id <> auth.uid());

create policy sources_select on sources for select using (is_lab_member(lab_id));
create policy sources_insert on sources for insert with check (is_lab_admin(lab_id));
create policy sources_update on sources for update using (is_lab_admin(lab_id)) with check (is_lab_admin(lab_id));

create policy blobs_select on blobs for select using (
  exists (
    select 1 from file_locations fl
    where fl.sha256 = blobs.sha256 and fl.deleted_at is null and is_lab_member(fl.lab_id)
  )
);

create policy file_locations_select on file_locations for select using (is_lab_member(lab_id));
create policy chunks_select on chunks for select using (is_lab_member(lab_id));
create policy previews_select on previews for select using (is_lab_member(lab_id));

create policy audit_log_select on audit_log for select using (is_lab_admin(lab_id));
create policy audit_log_insert on audit_log for insert
  with check (is_lab_member(lab_id) and actor = auth.uid());

create function create_lab(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_lab uuid;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  insert into labs (name) values (btrim(p_name)) returning id into v_lab;
  insert into members (lab_id, user_id, role) values (v_lab, v_user, 'admin');
  insert into audit_log (lab_id, actor, action, target) values (v_lab, v_user, 'lab.create', btrim(p_name));
  return v_lab;
end
$$;

create function lab_members(p_lab_id uuid)
returns table (user_id uuid, email text, role member_role, joined_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from members m join auth.users u on u.id = m.user_id
  where m.lab_id = p_lab_id and is_lab_member(p_lab_id)
  order by m.created_at
$$;

create function source_progress(p_lab_id uuid)
returns table (source_id uuid, pending bigint, indexed bigint, failed bigint)
language sql stable security invoker set search_path = public as $$
  select s.id,
    count(fl.id) filter (where fl.index_state = 'pending'),
    count(fl.id) filter (where fl.index_state = 'indexed'),
    count(fl.id) filter (where fl.index_state = 'failed')
  from sources s
  left join file_locations fl on fl.source_id = s.id and fl.deleted_at is null
  where s.lab_id = p_lab_id
  group by s.id
$$;

-- Supabase grants everything on new public tables to anon and authenticated by default.
-- Reset that so the column-level grants below are the whole surface.
revoke all on all tables in schema public from anon, authenticated;
revoke all on function
  is_lab_member(uuid), is_lab_admin(uuid), create_lab(text), lab_members(uuid), source_progress(uuid)
from public, anon, authenticated;

grant usage on schema public to authenticated;
grant select on labs, members, blobs, file_locations, chunks, previews, audit_log to authenticated;
grant select (
  id, lab_id, kind, root_path, account_label, scan_requested_at,
  scan_started_at, scan_finished_at, scan_error, created_at
) on sources to authenticated;
grant insert (lab_id, kind, root_path, account_label, token_ciphertext) on sources to authenticated;
grant update (root_path, scan_requested_at) on sources to authenticated;
grant delete on members to authenticated;
grant insert (lab_id, actor, action, target) on audit_log to authenticated;
grant execute on function
  is_lab_member(uuid), is_lab_admin(uuid), create_lab(text), lab_members(uuid), source_progress(uuid)
to authenticated;
