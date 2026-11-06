-- The lab map (decisions.md, "the lab map"): how a lab's files, protocols, experiments, people
-- and instruments connect. Every link it draws already exists: a label's experiment, person
-- and instrument, a protocol's attached files, a chart's file and protocol, a talk-through's
-- recording and protocol, and an experiment's protocol. The one thing it adds is "similar in
-- meaning": each file's few nearest files by embedding, worked out by the worker and kept
-- here, never computed per request.
--
-- Node ids are text: file:<sha256>, protocol:<uuid>, experiment:<uuid>, person:<uuid> and
-- instrument:<name, lowercased and trimmed>, since a label's instrument is free text.

-- One row per file with content chunks: the mean of their embeddings (chunk 0, the name and
-- path, is left out, so two files aren't "similar" for sitting in one folder). A trigger on
-- chunks moves chunks_changed_at; the worker sees computed_at fall behind and redoes the
-- vector and the neighbor lists it touches. Worker-only: members never read vectors.
create table file_vectors (
  lab_id uuid not null references labs (id) on delete cascade,
  sha256 text not null references blobs (sha256),
  embedding vector(1024),
  embed_model text,
  chunks_changed_at timestamptz not null default clock_timestamp(),
  -- The chunk change the vector was computed from, and the vector the neighbor lists were
  -- last redone for: a vector that moved has listed_at behind computed_at until its lists
  -- are redone, so a job that stops between the two picks the lists up again.
  computed_at timestamptz,
  listed_at timestamptz,
  primary key (lab_id, sha256),
  check ((embedding is null) = (embed_model is null))
);
create index file_vectors_stale_idx on file_vectors (chunks_changed_at)
  where computed_at is null or computed_at < chunks_changed_at;
create index file_vectors_unlisted_idx on file_vectors (lab_id)
  where computed_at is not null and listed_at is distinct from computed_at;
create index file_vectors_embedding_idx on file_vectors using hnsw (embedding vector_cosine_ops);
create index file_vectors_sha_idx on file_vectors (sha256);

-- Each file's nearest files above the threshold, nearest first (bl_worker/neighbors.py keeps
-- the list). A list is directed: b can be on a's list without a being on b's.
create table file_neighbors (
  lab_id uuid not null,
  sha256 text not null,
  neighbor text not null,
  similarity real not null check (similarity between -1 and 1),
  primary key (lab_id, sha256, neighbor),
  foreign key (lab_id, sha256) references file_vectors (lab_id, sha256) on delete cascade,
  foreign key (lab_id, neighbor) references file_vectors (lab_id, sha256) on delete cascade,
  check (sha256 <> neighbor)
);
create index file_neighbors_reverse_idx on file_neighbors (lab_id, neighbor);

alter table file_vectors enable row level security;
alter table file_neighbors enable row level security;
create policy file_neighbors_select on file_neighbors for select using (is_lab_member(lab_id));

-- A content chunk written, re-embedded or removed marks its file's vector stale. Only the
-- worker writes chunks. A delete only touches an existing row, so a lab's cascade, which
-- takes file_vectors with it, never tries to insert one.
create function chunks_touch_file_vector() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    update file_vectors set chunks_changed_at = clock_timestamp()
    where lab_id = old.lab_id and sha256 = old.sha256;
    return null;
  end if;
  insert into file_vectors (lab_id, sha256) values (new.lab_id, new.sha256)
  on conflict (lab_id, sha256) do update set chunks_changed_at = clock_timestamp();
  return null;
end
$$;

create trigger chunks_touch_file_vector after insert or update of text, embedding on chunks
  for each row when (new.ord > 0) execute function chunks_touch_file_vector();
create trigger chunks_untouch_file_vector after delete on chunks
  for each row when (old.ord > 0) execute function chunks_touch_file_vector();

-- Every chunk already written gets its row, so the worker builds vectors for files indexed
-- before the map existed.
insert into file_vectors (lab_id, sha256)
select distinct c.lab_id, c.sha256 from chunks c where c.ord > 0
on conflict do nothing;

-- A hub's files come from these lookups.
create index labels_experiment_idx on labels (lab_id, experiment_id) where experiment_id is not null;
create index labels_person_idx on labels (lab_id, person_id) where person_id is not null;
create index labels_instrument_idx on labels (lab_id, lower(btrim(instrument))) where instrument is not null;

-- Every helper below runs as the table owner and reads only p_lab_id's rows: row by row,
-- RLS's membership check took most of the time on a 20,000-file lab (1.5 s for the files
-- alone). Members can't call the helpers; the three views they can call check membership
-- once, first.
create function map_require_member(p_lab_id uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
end
$$;

-- The map's files: live and indexed, one row per content, named as search names them (the
-- label's clean name, else the newest copy's file name).
create function map_files(p_lab_id uuid, p_shas text[] default null)
returns table (sha256 text, name text, file_kind file_kind, modified_at timestamptz)
language sql stable security definer set search_path = public as $$
  select f.sha256,
    coalesce(case when l.status <> 'needs_look' then l.clean_name end, f.original_name),
    b.file_kind, f.modified_at
  from (
    select distinct on (fl.sha256 collate "C") fl.sha256, fl.original_name, fl.modified_at
    from file_locations fl
    where fl.lab_id = p_lab_id and fl.deleted_at is null and fl.index_state = 'indexed'
      and (p_shas is null or fl.sha256 = any (p_shas))
    order by fl.sha256 collate "C", fl.modified_at desc
  ) f
  join blobs b on b.sha256 = f.sha256
  left join labels l on l.lab_id = p_lab_id and l.sha256 = f.sha256
$$;

-- Every link from a file to a hub, one row per pair. `via` says what made it: a label, a
-- protocol's attached file, a chart or a talk-through (attached wins when there are several).
-- Archived protocols and "Needs a look" labels (no label to show) draw nothing.
create function map_links(p_lab_id uuid, p_shas text[] default null)
returns table (sha256 text, hub text, via text)
language sql stable security definer set search_path = public as $$
  select distinct on (x.sha256 collate "C", x.hub collate "C") x.sha256, x.hub, x.via
  from (
    select l.sha256, 'experiment:' || l.experiment_id as hub, 'label' as via, 0 as pick
    from labels l
    where l.lab_id = p_lab_id and l.status <> 'needs_look' and l.experiment_id is not null
      and (p_shas is null or l.sha256 = any (p_shas))
    union all
    select l.sha256, 'person:' || l.person_id, 'label', 0
    from labels l
    where l.lab_id = p_lab_id and l.status <> 'needs_look' and l.person_id is not null
      and (p_shas is null or l.sha256 = any (p_shas))
    union all
    select l.sha256, 'instrument:' || lower(btrim(l.instrument)), 'label', 0
    from labels l
    where l.lab_id = p_lab_id and l.status <> 'needs_look' and l.instrument is not null
      and (p_shas is null or l.sha256 = any (p_shas))
    union all
    select pf.sha256, 'protocol:' || pf.protocol_id, 'attached', 1
    from protocol_files pf join protocols p on p.id = pf.protocol_id
    where pf.lab_id = p_lab_id and p.archived_at is null
      and (p_shas is null or pf.sha256 = any (p_shas))
    union all
    select c.sha256, 'protocol:' || c.protocol_id, 'chart', 2
    from charts c join protocols p on p.id = c.protocol_id
    where c.lab_id = p_lab_id and p.archived_at is null
      and (p_shas is null or c.sha256 = any (p_shas))
    union all
    select fl.sha256, 'protocol:' || t.protocol_id, 'talk-through', 3
    from talk_throughs t
    join file_locations fl on fl.id = t.location_id
    join protocols p on p.id = t.protocol_id
    where t.lab_id = p_lab_id and fl.sha256 is not null and p.archived_at is null
      and (p_shas is null or fl.sha256 = any (p_shas))
  ) x
  order by x.sha256 collate "C", x.hub collate "C", x.pick
$$;

-- The hubs: protocols (not archived), experiments, people and instruments. An instrument is a
-- name on a label or a live instrument PC; its shown name is the spelling most labels use.
create function map_hubs(p_lab_id uuid)
returns table (id text, kind text, name text)
language sql stable security definer set search_path = public as $$
  select 'protocol:' || p.id, 'protocol', v.title
  from protocols p join protocol_versions v on v.id = p.current_version_id
  where p.lab_id = p_lab_id and p.archived_at is null
  union all
  select 'experiment:' || e.id, 'experiment', e.name from experiments e where e.lab_id = p_lab_id
  union all
  select 'person:' || pe.id, 'person', pe.display_name from people pe where pe.lab_id = p_lab_id
  union all
  select 'instrument:' || i.key, 'instrument', min(i.name collate "C")
  from (
    select lower(btrim(l.instrument)) as key,
      mode() within group (order by btrim(l.instrument) collate "C") as name
    from labels l
    where l.lab_id = p_lab_id and l.status <> 'needs_look' and l.instrument is not null
    group by 1
    union all
    select lower(i.name), i.name from instruments i where i.lab_id = p_lab_id and i.revoked_at is null
  ) i
  group by i.key
$$;

-- One hub's live files, newest first, up to p_limit, each with the hub's full count.
create function map_hub_files(p_lab_id uuid, p_hub text, p_limit int)
returns table (sha256 text, total bigint)
language plpgsql stable security definer set search_path = public as $$
declare
  v_kind text := split_part(p_hub, ':', 1);
  v_key text := substr(p_hub, length(v_kind) + 2);
begin
  return query
  with members as (
    select l.sha256 from labels l
    where v_kind = 'experiment' and l.lab_id = p_lab_id and l.status <> 'needs_look'
      and l.experiment_id = (case when v_kind = 'experiment' then v_key::uuid end)
    union
    select l.sha256 from labels l
    where v_kind = 'person' and l.lab_id = p_lab_id and l.status <> 'needs_look'
      and l.person_id = (case when v_kind = 'person' then v_key::uuid end)
    union
    select l.sha256 from labels l
    where v_kind = 'instrument' and l.lab_id = p_lab_id and l.status <> 'needs_look'
      and l.instrument is not null and lower(btrim(l.instrument)) = v_key
    union
    select pf.sha256 from protocol_files pf
    where v_kind = 'protocol' and pf.lab_id = p_lab_id
      and pf.protocol_id = (case when v_kind = 'protocol' then v_key::uuid end)
    union
    select c.sha256 from charts c
    where v_kind = 'protocol' and c.lab_id = p_lab_id
      and c.protocol_id = (case when v_kind = 'protocol' then v_key::uuid end)
    union
    select fl.sha256 from talk_throughs t join file_locations fl on fl.id = t.location_id
    where v_kind = 'protocol' and t.lab_id = p_lab_id and fl.sha256 is not null
      and t.protocol_id = (case when v_kind = 'protocol' then v_key::uuid end)
  ),
  live as (
    select fl.sha256, max(fl.modified_at) as modified_at
    from file_locations fl join members m on m.sha256 = fl.sha256
    where fl.lab_id = p_lab_id and fl.deleted_at is null and fl.index_state = 'indexed'
    group by fl.sha256
  )
  select live.sha256, count(*) over () from live
  order by live.modified_at desc, live.sha256
  limit greatest(p_limit, 0);
end
$$;

-- The nodes for a set of ids, shaped for the map: a file with its name and kind, a hub with
-- how many files it holds. Ids the lab doesn't have are left out.
create function map_nodes(p_lab_id uuid, p_ids text[])
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_shas text[] := array(select substr(i, 6) from unnest(p_ids) i where i like 'file:%');
  v_hubs text[] := array(select i from unnest(p_ids) i where i not like 'file:%');
begin
  return coalesce((
    select jsonb_agg(n.node order by n.ord, n.name)
    from (
      select 1 as ord, f.name, jsonb_build_object(
        'id', 'file:' || f.sha256, 'kind', 'file', 'name', f.name, 'fileKind', f.file_kind
      ) as node
      from map_files(p_lab_id, v_shas) f
      union all
      select 0, h.name, jsonb_build_object(
        'id', h.id, 'kind', h.kind, 'name', h.name,
        'files', coalesce((select t.total from map_hub_files(p_lab_id, h.id, 1) t), 0)
      )
      from map_hubs(p_lab_id) h where h.id = any (v_hubs)
    ) n
  ), '[]'::jsonb);
end
$$;

-- Every link among a set of ids: file to hub, experiment to protocol, and, when asked,
-- similar in meaning (one edge per pair, at the higher of the two similarities).
create function map_edges(p_lab_id uuid, p_ids text[], p_similar boolean)
returns jsonb
language sql stable security definer set search_path = public as $$
  with ids as (select unnest(p_ids) as id),
  shas as (select array(select substr(id, 6) from ids where id like 'file:%') as v),
  edges as (
    select 'file:' || m.sha256 as source, m.hub as target, m.via as kind, null::real as similarity
    from shas, map_links(p_lab_id, shas.v) m
    where m.hub in (select id from ids)
    union all
    select 'experiment:' || e.id, 'protocol:' || e.protocol_id, 'uses', null
    from experiments e
    where e.lab_id = p_lab_id and e.protocol_id is not null
      and 'experiment:' || e.id in (select id from ids)
      and 'protocol:' || e.protocol_id in (select id from ids)
    union all
    select 'file:' || least(n.sha256, n.neighbor), 'file:' || greatest(n.sha256, n.neighbor),
      'similar', max(n.similarity)
    from shas, file_neighbors n
    where p_similar and n.lab_id = p_lab_id and n.sha256 = any (shas.v) and n.neighbor = any (shas.v)
    group by 1, 2
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'source', e.source, 'target', e.target, 'kind', e.kind, 'similarity', round(e.similarity::numeric, 3)
  )) order by e.source, e.target), '[]'::jsonb)
  from edges e
$$;

-- The whole lab at a glance: the hubs with how many files each holds, an experiment's
-- protocol, and how many files two hubs share. Files themselves come one hub at a time.
create function lab_map(p_lab_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform map_require_member(p_lab_id);
  return (
    with live as (
      select distinct fl.sha256 from file_locations fl
      where fl.lab_id = p_lab_id and fl.deleted_at is null and fl.index_state = 'indexed'
    ),
    links as (select m.sha256, m.hub from map_links(p_lab_id) m join live on live.sha256 = m.sha256),
    hubs as (select * from map_hubs(p_lab_id)),
    counts as (select hub, count(*) as n from links group by hub),
    uses as (
      select 'experiment:' || e.id as a, 'protocol:' || e.protocol_id as b
      from experiments e join protocols p on p.id = e.protocol_id
      where e.lab_id = p_lab_id and p.archived_at is null
    ),
    shared as (
      select l1.hub as a, l2.hub as b, count(*) as n
      from links l1 join links l2 on l2.sha256 = l1.sha256 and l1.hub < l2.hub
      group by 1, 2
    ),
    -- Every hub shares a file with most others in a busy lab; four links each keeps the
    -- picture to who works with whom, not a web of everything.
    strongest as (
      select r.a, r.b, r.n from (
        select s.a, s.b, s.n,
          row_number() over (partition by s.a order by s.n desc, s.b) as ra,
          row_number() over (partition by s.b order by s.n desc, s.a) as rb
        from shared s
        where not exists (select 1 from uses u where (u.a, u.b) in ((s.a, s.b), (s.b, s.a)))
      ) r
      where r.ra <= 4 or r.rb <= 4
    )
    select jsonb_build_object(
      'files', (select count(*) from live),
      'linked', (select count(distinct sha256) from links),
      'hubs', coalesce((
        select jsonb_agg(jsonb_build_object('id', h.id, 'kind', h.kind, 'name', h.name, 'files', coalesce(c.n, 0))
          order by h.kind, lower(h.name), h.id)
        from hubs h left join counts c on c.hub = h.id
      ), '[]'::jsonb),
      'links', coalesce((
        select jsonb_agg(jsonb_build_object('source', x.a, 'target', x.b, 'kind', x.kind, 'weight', x.n) order by x.a, x.b)
        from (
          select u.a, u.b, 'uses' as kind, coalesce(s.n, 0) as n
          from uses u left join shared s on (s.a, s.b) in ((u.a, u.b), (u.b, u.a))
          union all
          select a, b, 'shared', n from strongest
        ) x
      ), '[]'::jsonb)
    )
  );
end
$$;

-- One hub's files for the lab map, newest first up to p_limit, with every link they have to a
-- hub. With p_similar, also the similar-in-meaning pairs among these files and the files of
-- the other hubs open on the map (p_with, each up to the same limit).
create function lab_map_hub(p_lab_id uuid, p_hub text, p_limit int default 400,
  p_similar boolean default false, p_with text[] default '{}')
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_files text[];
  v_total bigint;
  v_others text[] := '{}';
  v_hubs text[];
begin
  perform map_require_member(p_lab_id);
  if p_limit not between 1 and 2000 then
    raise exception 'limit is 1 to 2000' using errcode = '22023';
  end if;
  if not exists (select 1 from map_hubs(p_lab_id) h where h.id = p_hub) then
    return null;
  end if;
  select coalesce(array_agg('file:' || t.sha256), '{}'), coalesce(max(t.total), 0)
    into v_files, v_total
    from map_hub_files(p_lab_id, p_hub, p_limit) t;
  if p_similar then
    select coalesce(array_agg(distinct 'file:' || t.sha256), '{}') into v_others
    from unnest(p_with) w, map_hub_files(p_lab_id, w, p_limit) t
    where w <> p_hub;
  end if;
  v_hubs := array(select h.id from map_hubs(p_lab_id) h);
  return jsonb_build_object(
    'hub', p_hub,
    'total', v_total,
    'nodes', map_nodes(p_lab_id, v_files),
    'edges', (
      select coalesce(jsonb_agg(e), '[]'::jsonb)
      from jsonb_array_elements(map_edges(p_lab_id, v_files || v_others || v_hubs, p_similar)) e
      where e ->> 'source' = any (v_files) or e ->> 'target' = any (v_files)
    )
  );
end
$$;

-- The neighbors one step from a set of nodes: a file's hubs (and, with p_similar, its similar
-- files), a hub's newest files up to p_per_hub, and an experiment's protocol or a protocol's
-- experiments.
create function map_step(p_lab_id uuid, p_ids text[], p_per_hub int, p_similar boolean)
returns setof text
language sql stable security definer set search_path = public as $$
  with ids as (select unnest(p_ids) as id),
  shas as (select array(select substr(id, 6) from ids where id like 'file:%') as v)
  select m.hub from shas, map_links(p_lab_id, shas.v) m
  union
  select 'file:' || t.sha256
  from ids, map_hub_files(p_lab_id, ids.id, p_per_hub) t
  where ids.id not like 'file:%'
  union
  select 'protocol:' || e.protocol_id from experiments e
  where e.lab_id = p_lab_id and e.protocol_id is not null and 'experiment:' || e.id in (select id from ids)
  union
  select 'experiment:' || e.id from experiments e
  where e.lab_id = p_lab_id and 'protocol:' || e.protocol_id in (select id from ids)
  union
  select 'file:' || case when n.sha256 = any (shas.v) then n.neighbor else n.sha256 end
  from shas, file_neighbors n
  where p_similar and n.lab_id = p_lab_id and (n.sha256 = any (shas.v) or n.neighbor = any (shas.v))
$$;

-- The map around one thing: everything within p_depth steps (1 or 2). A hub shows up to 150
-- of its files one step out and 24 two steps out; `more` says how many each hub left out, so
-- the map can offer them as a search. Null when the lab has no such node.
create function lab_map_local(p_lab_id uuid, p_node text, p_depth int default 1, p_similar boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_nodes text[] := array[p_node];
  v_frontier text[] := array[p_node];
  v_next text[];
  v_live text[];
  v_center jsonb;
  v_node_rows jsonb;
  v_edges jsonb;
begin
  perform map_require_member(p_lab_id);
  if p_depth not between 1 and 2 then
    raise exception 'depth is 1 or 2' using errcode = '22023';
  end if;
  v_center := map_nodes(p_lab_id, array[p_node]);
  if jsonb_array_length(v_center) = 0 then
    return null;
  end if;
  for step in 1..p_depth loop
    v_next := array(
      select distinct s from map_step(p_lab_id, v_frontier, case step when 1 then 150 else 24 end, p_similar) s
      where s <> all (v_nodes)
    );
    v_nodes := v_nodes || v_next;
    -- A hub reached on the last step isn't opened, so only the new nodes go on.
    v_frontier := v_next;
  end loop;
  -- A similar file whose locations are all gone has no node; only ids with one stay.
  v_node_rows := map_nodes(p_lab_id, v_nodes);
  v_live := array(select n ->> 'id' from jsonb_array_elements(v_node_rows) n);
  v_edges := map_edges(p_lab_id, v_live, p_similar);
  return jsonb_build_object(
    'center', p_node,
    'depth', p_depth,
    'nodes', v_node_rows,
    'edges', v_edges,
    'more', coalesce((
      select jsonb_agg(jsonb_build_object('hub', h.id, 'hidden', h.files - h.shown) order by h.id)
      from (
        select n ->> 'id' as id, (n ->> 'files')::int as files,
          (select count(*) from jsonb_array_elements(v_edges) e
            where e ->> 'target' = n ->> 'id' and e ->> 'source' like 'file:%' and e ->> 'kind' <> 'similar') as shown
        from jsonb_array_elements(v_node_rows) n
        where n ->> 'kind' <> 'file'
      ) h
      where h.files > h.shown
    ), '[]'::jsonb)
  );
end
$$;

revoke all on file_vectors, file_neighbors from anon, authenticated;
revoke all on function
  chunks_touch_file_vector(), map_require_member(uuid), map_files(uuid, text[]),
  map_links(uuid, text[]), map_hubs(uuid), map_hub_files(uuid, text, int),
  map_nodes(uuid, text[]), map_edges(uuid, text[], boolean), map_step(uuid, text[], int, boolean),
  lab_map(uuid), lab_map_hub(uuid, text, int, boolean, text[]), lab_map_local(uuid, text, int, boolean)
from public, anon, authenticated;
grant select on file_neighbors to authenticated;
grant execute on function
  lab_map(uuid), lab_map_hub(uuid, text, int, boolean, text[]), lab_map_local(uuid, text, int, boolean)
to authenticated;
