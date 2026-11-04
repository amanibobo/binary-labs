-- Protocols and tutorials: pages a lab writes here, since Dropbox access is read-only.
-- Every save inserts an immutable protocol_versions row and moves
-- protocols.current_version_id to it, so a Phase 4 flag can cite the exact version.

-- A new enum value can't be used in the transaction that adds it. Only plpgsql bodies,
-- which aren't checked until they run, name these.
alter type audit_action add value if not exists 'protocol.create';
alter type audit_action add value if not exists 'protocol.save';
alter type audit_action add value if not exists 'protocol.archive';
alter type audit_action add value if not exists 'protocol.link_file';
alter type audit_action add value if not exists 'protocol.unlink_file';

create type protocol_kind as enum ('protocol', 'tutorial');

create table protocols (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  kind protocol_kind not null,
  -- Checked at commit (the foreign key below is deferred), so a protocol and its first
  -- version go in together and a protocol never exists without one.
  current_version_id uuid not null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, lab_id)
);
create index protocols_lab_idx on protocols (lab_id) where archived_at is null;

create table protocol_versions (
  id uuid primary key default gen_random_uuid(),
  protocol_id uuid not null,
  lab_id uuid not null,
  version int not null check (version > 0),
  -- The version this one was edited from; null only for the first. At most one version
  -- per base keeps history a line: two saves from the same version can't both land.
  based_on uuid,
  title text not null check (length(btrim(title)) between 1 and 200),
  body text not null check (length(body) <= 200000),
  -- Phase 4 check rules; tutorials never carry any.
  expected_values jsonb not null default '[]' check (jsonb_typeof(expected_values) = 'array'),
  note text check (note is null or length(btrim(note)) between 1 and 300),
  author uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  tsv tsvector generated always as (
    setweight(to_tsvector('english', searchable_text(title)), 'A') || setweight(to_tsvector('english', body), 'B')
  ) stored,
  unique (protocol_id, version),
  unique nulls not distinct (protocol_id, based_on),
  unique (id, protocol_id),
  foreign key (protocol_id, lab_id) references protocols (id, lab_id) on delete cascade,
  foreign key (based_on, protocol_id) references protocol_versions (id, protocol_id),
  check ((version = 1) = (based_on is null))
);
create index protocol_versions_tsv_idx on protocol_versions using gin (tsv);

alter table protocols add constraint protocols_current_version_fk
  foreign key (current_version_id, id) references protocol_versions (id, protocol_id)
  deferrable initially deferred;

create table protocol_files (
  protocol_id uuid not null,
  lab_id uuid not null,
  sha256 text not null references blobs (sha256),
  note text check (note is null or length(btrim(note)) between 1 and 200),
  ord int not null default 0,
  primary key (protocol_id, sha256),
  foreign key (protocol_id, lab_id) references protocols (id, lab_id) on delete cascade
);

alter table experiments add column protocol_id uuid;
alter table experiments add foreign key (protocol_id, lab_id) references protocols (id, lab_id)
  on delete set null (protocol_id);

alter table protocols enable row level security;
alter table protocol_versions enable row level security;
alter table protocol_files enable row level security;

create policy protocols_select on protocols for select using (is_lab_member(lab_id));
create policy protocols_insert on protocols for insert with check (is_lab_member(lab_id));
create policy protocols_update on protocols for update
  using (is_lab_admin(lab_id)) with check (is_lab_admin(lab_id));

create policy protocol_versions_select on protocol_versions for select using (is_lab_member(lab_id));
create policy protocol_versions_insert on protocol_versions for insert
  with check (is_lab_member(lab_id) and author = auth.uid());

create policy protocol_files_select on protocol_files for select using (is_lab_member(lab_id));
create policy protocol_files_insert on protocol_files for insert with check (is_lab_member(lab_id));
create policy protocol_files_delete on protocol_files for delete using (is_lab_member(lab_id));

-- Errors a person can cause carry their own codes: BL101 someone saved since you
-- started, BL102 the page is archived, BL103 no such page (or not yours to see).
create function protocol_versions_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p protocols;
begin
  if not is_lab_member(new.lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  -- Locking the protocol orders concurrent saves, so the second one sees the first.
  select * into p from protocols where id = new.protocol_id and lab_id = new.lab_id for update;
  if not found then
    raise exception 'no such protocol' using errcode = 'BL103';
  end if;
  if p.archived_at is not null then
    raise exception 'this page is archived' using errcode = 'BL102';
  end if;
  if new.based_on is null then
    if p.current_version_id <> new.id then
      raise exception 'only a new protocol starts without a base version' using errcode = '22023';
    end if;
    new.version := 1;
  elsif new.based_on <> p.current_version_id then
    raise exception 'someone saved a newer version' using errcode = 'BL101';
  else
    select v.version + 1 into new.version from protocol_versions v where v.id = new.based_on;
  end if;
  new.title := btrim(new.title);
  new.note := nullif(btrim(new.note), '');
  return new;
end
$$;

create function protocol_versions_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update protocols set current_version_id = new.id
  where id = new.protocol_id and current_version_id <> new.id;
  insert into audit_log (lab_id, actor, action, target)
  values (
    new.lab_id, new.author,
    (case when new.version = 1 then 'protocol.create' else 'protocol.save' end)::audit_action,
    new.protocol_id::text
  );
  return null;
end
$$;

create trigger protocol_versions_before_insert before insert on protocol_versions
  for each row execute function protocol_versions_before_insert();
create trigger protocol_versions_after_insert after insert on protocol_versions
  for each row execute function protocol_versions_after_insert();

-- Archiving is one way and stamps its own time.
create function protocols_archive() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.archived_at is not null then
    raise exception 'this page is archived' using errcode = 'BL102';
  end if;
  new.archived_at := now();
  insert into audit_log (lab_id, actor, action, target)
  values (new.lab_id, auth.uid(), 'protocol.archive', new.id::text);
  return new;
end
$$;

create trigger protocols_archive before update of archived_at on protocols
  for each row when (new.archived_at is distinct from old.archived_at)
  execute function protocols_archive();

create function protocol_files_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p protocols;
begin
  if not is_lab_member(new.lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  select * into p from protocols where id = new.protocol_id and lab_id = new.lab_id for update;
  if not found then
    raise exception 'no such protocol' using errcode = 'BL103';
  end if;
  if p.archived_at is not null then
    raise exception 'this page is archived' using errcode = 'BL102';
  end if;
  if not exists (
    select 1 from file_locations fl
    where fl.lab_id = new.lab_id and fl.sha256 = new.sha256 and fl.deleted_at is null
  ) then
    raise exception 'no such file in this lab' using errcode = 'BL104';
  end if;
  new.note := nullif(btrim(new.note), '');
  new.ord := coalesce((select max(f.ord) from protocol_files f where f.protocol_id = new.protocol_id), 0) + 1;
  return new;
end
$$;

create function protocol_files_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into audit_log (lab_id, actor, action, target)
    values (new.lab_id, auth.uid(), 'protocol.link_file', new.protocol_id::text || ' ' || new.sha256);
  -- A lab or protocol being deleted takes its links with it; that isn't an unlink.
  elsif exists (select 1 from protocols where id = old.protocol_id) then
    insert into audit_log (lab_id, actor, action, target)
    values (old.lab_id, auth.uid(), 'protocol.unlink_file', old.protocol_id::text || ' ' || old.sha256);
  end if;
  return null;
end
$$;

create trigger protocol_files_before_insert before insert on protocol_files
  for each row execute function protocol_files_before_insert();
create trigger protocol_files_audit after insert or delete on protocol_files
  for each row execute function protocol_files_audit();

create function link_protocol_file(p_protocol_id uuid, p_sha256 text, p_note text default null)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_lab uuid;
begin
  select p.lab_id into v_lab from protocols p where p.id = p_protocol_id;
  if not found then
    raise exception 'no such protocol' using errcode = 'BL103';
  end if;
  insert into protocol_files (protocol_id, lab_id, sha256, note)
  values (p_protocol_id, v_lab, p_sha256, p_note)
  on conflict (protocol_id, sha256) do nothing;
end
$$;

create function unlink_protocol_file(p_protocol_id uuid, p_sha256 text) returns void
language sql security invoker set search_path = public as $$
  delete from protocol_files where protocol_id = p_protocol_id and sha256 = p_sha256
$$;

create function create_protocol(
  p_lab_id uuid,
  p_kind protocol_kind,
  p_title text,
  p_body text,
  p_note text default null,
  p_file_sha256 text default null
)
returns table (protocol_id uuid, version_id uuid, version int)
language plpgsql security invoker set search_path = public as $$
declare
  v_protocol uuid := gen_random_uuid();
  v_version uuid := gen_random_uuid();
begin
  insert into protocols (id, lab_id, kind, current_version_id) values (v_protocol, p_lab_id, p_kind, v_version);
  insert into protocol_versions (id, protocol_id, lab_id, title, body, note)
  values (v_version, v_protocol, p_lab_id, p_title, coalesce(p_body, ''), p_note);
  if p_file_sha256 is not null then
    perform link_protocol_file(v_protocol, p_file_sha256);
  end if;
  return query select v_protocol, v_version, 1;
end
$$;

-- Saves a new version on top of p_base_version_id, the one the editor started from.
-- Fails with BL101 if someone saved in between, so nobody overwrites anyone silently.
create function save_protocol(
  p_protocol_id uuid,
  p_base_version_id uuid,
  p_title text,
  p_body text,
  p_note text default null
)
returns table (protocol_id uuid, version_id uuid, version int)
language plpgsql security invoker set search_path = public as $$
declare
  v_lab uuid;
  v_id uuid;
  v_number int;
begin
  select p.lab_id into v_lab from protocols p where p.id = p_protocol_id;
  if not found then
    raise exception 'no such protocol' using errcode = 'BL103';
  end if;
  if p_base_version_id is null then
    raise exception 'a save names the version it started from' using errcode = '22023';
  end if;
  insert into protocol_versions (protocol_id, lab_id, based_on, title, body, note)
  values (p_protocol_id, v_lab, p_base_version_id, p_title, coalesce(p_body, ''), p_note)
  returning protocol_versions.id, protocol_versions.version into v_id, v_number;
  return query select p_protocol_id, v_id, v_number;
end
$$;

create function archive_protocol(p_protocol_id uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_lab uuid;
begin
  select p.lab_id into v_lab from protocols p where p.id = p_protocol_id;
  if not found then
    raise exception 'no such protocol' using errcode = 'BL103';
  end if;
  if not is_lab_admin(v_lab) then
    raise exception 'only admins can archive a page' using errcode = '42501';
  end if;
  update protocols set archived_at = now() where id = p_protocol_id;
end
$$;

-- The lab's pages as the list shows them: current title and version, archived ones left out.
create function protocol_list(p_lab_id uuid)
returns table (
  id uuid,
  kind protocol_kind,
  title text,
  version int,
  version_id uuid,
  author uuid,
  updated_at timestamptz,
  created_at timestamptz
)
language sql stable security invoker set search_path = public as $$
  select p.id, p.kind, v.title, v.version, v.id, v.author, v.created_at, p.created_at
  from protocols p
  join protocol_versions v on v.id = p.current_version_id
  where p.lab_id = p_lab_id and p.archived_at is null
  order by lower(v.title), p.id
$$;

-- One version of a page with what the page view needs around it; p_version null is the current one.
create function protocol_version(p_protocol_id uuid, p_version int default null)
returns table (
  protocol_id uuid,
  kind protocol_kind,
  archived_at timestamptz,
  current_version_id uuid,
  current_version int,
  version_id uuid,
  version int,
  based_on uuid,
  title text,
  body text,
  note text,
  author uuid,
  created_at timestamptz
)
language sql stable security invoker set search_path = public as $$
  select p.id, p.kind, p.archived_at, p.current_version_id, cur.version,
    v.id, v.version, v.based_on, v.title, v.body, v.note, v.author, v.created_at
  from protocols p
  join protocol_versions cur on cur.id = p.current_version_id
  join protocol_versions v on v.protocol_id = p.id
    and (case when p_version is null then v.id = p.current_version_id else v.version = p_version end)
  where p.id = p_protocol_id
$$;

-- Files by content hash, shaped like folder_files rows, for the files a page links and
-- the file a new page starts from. A file with no live location drops out.
create function file_hits(p_lab_id uuid, p_shas text[])
returns table (
  sha256 text,
  file_kind file_kind,
  mime text,
  size bigint,
  has_preview boolean,
  snippet text,
  locations jsonb,
  label jsonb
)
language sql stable security invoker set search_path = public as $$
  select b.sha256, b.file_kind, b.mime, b.size,
    exists (select 1 from previews pr where pr.lab_id = p_lab_id and pr.sha256 = b.sha256),
    (select c.text from chunks c where c.lab_id = p_lab_id and c.sha256 = b.sha256 and c.ord = 1),
    live_locations_json(p_lab_id, b.sha256),
    label_json(p_lab_id, b.sha256)
  from blobs b
  where b.sha256 = any (p_shas)
    and exists (
      select 1 from file_locations fl
      where fl.lab_id = p_lab_id and fl.sha256 = b.sha256 and fl.deleted_at is null
    )
$$;

-- A file's extracted text, to start a page from. Extractions are shared across labs and
-- closed to members, so this checks the caller can see the file in this lab.
create function file_text(p_lab_id uuid, p_sha256 text) returns text
language sql stable security definer set search_path = public as $$
  select e.content
  from extractions e
  where e.sha256 = p_sha256
    and e.kind in ('text', 'table')
    and is_lab_member(p_lab_id)
    and exists (
      select 1 from file_locations fl
      where fl.lab_id = p_lab_id and fl.sha256 = p_sha256 and fl.deleted_at is null
    )
  order by e.created_at desc
  limit 1
$$;

-- Keyword search over current titles and bodies, ranked like search_files' keyword list:
-- more of the query's words first, then rank (title words weigh more).
create function search_protocols(p_lab_id uuid, p_query text, p_limit int default 5)
returns table (id uuid, kind protocol_kind, title text, version int, snippet text)
language sql stable security invoker set search_path = public as $$
  with q as (select prefix_tsquery(p_query) as tsq),
  terms as (
    select t.tq from (select to_tsquery('english', s) as tq from query_term_text(p_query) as s) t
    where numnode(t.tq) > 0
  ),
  hits as (
    select p.id, p.kind, v.title, v.version, v.body, v.tsv
    from protocols p
    join protocol_versions v on v.id = p.current_version_id
    cross join q
    where p.lab_id = p_lab_id and p.archived_at is null and q.tsq is not null and v.tsv @@ q.tsq
  )
  select h.id, h.kind, h.title, h.version,
    ts_headline('english', h.body, q.tsq,
      'StartSel="", StopSel="", MaxWords=30, MinWords=12, ShortWord=2, MaxFragments=1') as snippet
  from hits h
  cross join q
  order by (select count(*) from terms t where h.tsv @@ t.tq) desc, ts_rank_cd(h.tsv, q.tsq, 1) desc,
    lower(h.title), h.id
  limit p_limit
$$;

alter function search_protocols(uuid, text, int) set client_min_messages = warning;

revoke all on protocols, protocol_versions, protocol_files from anon, authenticated;
revoke all on function
  protocol_versions_before_insert(), protocol_versions_after_insert(), protocols_archive(),
  protocol_files_before_insert(), protocol_files_audit(),
  link_protocol_file(uuid, text, text), unlink_protocol_file(uuid, text),
  create_protocol(uuid, protocol_kind, text, text, text, text),
  save_protocol(uuid, uuid, text, text, text), archive_protocol(uuid),
  protocol_list(uuid), protocol_version(uuid, int), file_hits(uuid, text[]), file_text(uuid, text),
  search_protocols(uuid, text, int)
from public, anon, authenticated;

grant select (id, lab_id, kind, current_version_id, created_by, created_at, archived_at) on protocols
  to authenticated;
grant insert (id, lab_id, kind, current_version_id) on protocols to authenticated;
grant update (archived_at) on protocols to authenticated;
-- Versions are immutable: no update or delete, for anyone but the owner.
grant select on protocol_versions to authenticated;
grant insert (id, protocol_id, lab_id, based_on, title, body, note) on protocol_versions to authenticated;
grant select on protocol_files to authenticated;
grant insert (protocol_id, lab_id, sha256, note) on protocol_files to authenticated;
grant delete on protocol_files to authenticated;
grant select (protocol_id) on experiments to authenticated;
grant insert (protocol_id) on experiments to authenticated;
grant update (protocol_id) on experiments to authenticated;
grant execute on function
  link_protocol_file(uuid, text, text), unlink_protocol_file(uuid, text),
  create_protocol(uuid, protocol_kind, text, text, text, text),
  save_protocol(uuid, uuid, text, text, text), archive_protocol(uuid),
  protocol_list(uuid), protocol_version(uuid, int), file_hits(uuid, text[]), file_text(uuid, text),
  search_protocols(uuid, text, int)
to authenticated;
