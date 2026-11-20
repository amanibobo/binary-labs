-- The lab map, round 2 (decisions.md, "the lab map: tags, remembered views"): tags as dots,
-- similar in meaning between hubs, and each member's own view of the map kept per lab.
--
-- A tag is a hub like an instrument: its node id is tag:<the tag, lowercased and trimmed>,
-- shown as the spelling most labels use, linked to the files whose label carries it. Tags are
-- off by default, so every view takes p_tags and draws none without it.

-- A label's tags as the map keys them. Over 120 characters a tag has no node (a node id holds
-- at most 120 after its kind), and blank ones are dropped.
create function map_tag_keys(p_tags text[]) returns text[]
language sql immutable parallel safe set search_path = public as $$
  select coalesce(array_agg(distinct lower(btrim(t))), '{}')
  from unnest(p_tags) t
  where length(btrim(t)) between 1 and 120
$$;

create index labels_tag_keys_idx on labels using gin (map_tag_keys(tags)) where status <> 'needs_look';

-- Every link from a file to a tag. Needs-a-look labels draw nothing, as for the other hubs.
create function map_tag_links(p_lab_id uuid, p_shas text[] default null)
returns table (sha256 text, hub text, via text)
language sql stable security definer set search_path = public as $$
  select l.sha256, 'tag:' || k, 'label'
  from labels l, unnest(map_tag_keys(l.tags)) k
  where l.lab_id = p_lab_id and l.status <> 'needs_look' and cardinality(l.tags) > 0
    and (p_shas is null or l.sha256 = any (p_shas))
$$;

create function map_tags(p_lab_id uuid)
returns table (id text, kind text, name text)
language sql stable security definer set search_path = public as $$
  select 'tag:' || lower(btrim(t)), 'tag', mode() within group (order by btrim(t) collate "C")
  from labels l, unnest(l.tags) t
  where l.lab_id = p_lab_id and l.status <> 'needs_look' and length(btrim(t)) between 1 and 120
  group by lower(btrim(t))
$$;

-- As 0021, and a tag's files.
create or replace function map_hub_files(p_lab_id uuid, p_hub text, p_limit int)
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
    select l.sha256 from labels l
    where v_kind = 'tag' and l.lab_id = p_lab_id and l.status <> 'needs_look'
      and map_tag_keys(l.tags) @> array[v_key]
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

-- As 0021; a tag asked for by id is a node too.
create or replace function map_nodes(p_lab_id uuid, p_ids text[])
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
      from (
        select * from map_hubs(p_lab_id)
        union all
        select * from map_tags(p_lab_id) where exists (select 1 from unnest(v_hubs) i where i like 'tag:%')
      ) h
      where h.id = any (v_hubs)
    ) n
  ), '[]'::jsonb);
end
$$;

-- As 0021, and a file's tags when the tag is among the ids.
create or replace function map_edges(p_lab_id uuid, p_ids text[], p_similar boolean)
returns jsonb
language sql stable security definer set search_path = public as $$
  with ids as (select unnest(p_ids) as id),
  shas as (select array(select substr(id, 6) from ids where id like 'file:%') as v),
  edges as (
    select 'file:' || m.sha256 as source, m.hub as target, m.via as kind, null::real as similarity
    from shas, map_links(p_lab_id, shas.v) m
    where m.hub in (select id from ids)
    union all
    select 'file:' || m.sha256, m.hub, m.via, null
    from shas, map_tag_links(p_lab_id, shas.v) m
    where exists (select 1 from ids where id like 'tag:%') and m.hub in (select id from ids)
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

-- As 0021, and with p_tags a file's tags one step out.
create function map_step(p_lab_id uuid, p_ids text[], p_per_hub int, p_similar boolean, p_tags boolean)
returns setof text
language sql stable security definer set search_path = public as $$
  select s from map_step(p_lab_id, p_ids, p_per_hub, p_similar) s
  union
  select m.hub
  from map_tag_links(p_lab_id, array(select substr(i, 6) from unnest(p_ids) i where i like 'file:%')) m
  where p_tags
$$;

drop function lab_map(uuid);
drop function lab_map_hub(uuid, text, int, boolean, text[]);
drop function lab_map_local(uuid, text, int, boolean);

-- The whole lab at a glance, as 0021, and:
-- - with p_tags, the tags two or more live files carry, each linked to the two hubs it shares
--   most files with (never another tag), so a tag sits by what it's about;
-- - with p_similar, dotted lines between hubs whose files read alike: pairs of similar files
--   where neither file is in the other's hub (two files of one experiment say nothing about
--   that experiment and a person), two pairs at least, each hub keeping its three strongest.
create function lab_map(p_lab_id uuid, p_similar boolean default false, p_tags boolean default false)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform map_require_member(p_lab_id);
  return (
    with live as (
      select distinct fl.sha256 from file_locations fl
      where fl.lab_id = p_lab_id and fl.deleted_at is null and fl.index_state = 'indexed'
    ),
    links as materialized (select m.sha256, m.hub from map_links(p_lab_id) m join live on live.sha256 = m.sha256),
    tag_links as materialized (
      select m.sha256, m.hub from map_tag_links(p_lab_id) m join live on live.sha256 = m.sha256
      where p_tags
    ),
    hubs as (select * from map_hubs(p_lab_id)),
    counts as (select hub, count(*) as n from links group by hub),
    tag_counts as (select hub, count(*) as n from tag_links group by hub having count(*) >= 2),
    tags as (select t.id, t.kind, t.name, c.n from map_tags(p_lab_id) t join tag_counts c on c.hub = t.id where p_tags),
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
    ),
    tag_shared as (
      select r.a, r.b, r.n from (
        select t.hub as a, l.hub as b, count(*) as n,
          row_number() over (partition by t.hub order by count(*) desc, l.hub) as rank
        from tag_links t
        join tag_counts c on c.hub = t.hub
        join links l on l.sha256 = t.sha256
        group by t.hub, l.hub
      ) r
      where r.rank <= 2
    ),
    -- A list is directed, so a pair on both files' lists is one pair.
    file_pairs as (
      select least(fn.sha256, fn.neighbor) as f1, greatest(fn.sha256, fn.neighbor) as f2, max(fn.similarity) as s
      from file_neighbors fn
      where p_similar and fn.lab_id = p_lab_id
      group by 1, 2
    ),
    similar_pairs as (
      select least(l1.hub, l2.hub) as a, greatest(l1.hub, l2.hub) as b, count(*) as n, avg(p.s) as s
      from file_pairs p
      join links l1 on l1.sha256 = p.f1
      join links l2 on l2.sha256 = p.f2 and l2.hub <> l1.hub
      where not exists (select 1 from links x where x.sha256 = p.f1 and x.hub = l2.hub)
        and not exists (select 1 from links x where x.sha256 = p.f2 and x.hub = l1.hub)
      group by 1, 2
      having count(*) >= 2
    ),
    similar_strongest as (
      select r.a, r.b, r.s from (
        select p.a, p.b, p.s,
          row_number() over (partition by p.a order by p.n desc, p.s desc, p.b) as ra,
          row_number() over (partition by p.b order by p.n desc, p.s desc, p.a) as rb
        from similar_pairs p
      ) r
      where r.ra <= 3 or r.rb <= 3
    )
    select jsonb_build_object(
      'files', (select count(*) from live),
      'linked', (select count(distinct sha256) from links),
      'hubs', coalesce((
        select jsonb_agg(jsonb_build_object('id', h.id, 'kind', h.kind, 'name', h.name, 'files', h.n)
          order by h.kind, lower(h.name), h.id)
        from (
          select h.id, h.kind, h.name, coalesce(c.n, 0) as n from hubs h left join counts c on c.hub = h.id
          union all
          select id, kind, name, n from tags
        ) h
      ), '[]'::jsonb),
      'links', coalesce((
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'source', x.a, 'target', x.b, 'kind', x.kind, 'weight', x.n, 'similarity', round(x.s::numeric, 3)
        )) order by x.a, x.b, x.kind)
        from (
          select u.a, u.b, 'uses' as kind, coalesce(s.n, 0) as n, null::real as s
          from uses u left join shared s on (s.a, s.b) in ((u.a, u.b), (u.b, u.a))
          union all
          select a, b, 'shared', n, null from strongest
          union all
          select a, b, 'shared', n, null from tag_shared
          union all
          select a, b, 'similar', null, s from similar_strongest
        ) x
      ), '[]'::jsonb)
    )
  );
end
$$;

-- One hub's files, as 0021; with p_tags, their links to the lab's tags too.
create function lab_map_hub(p_lab_id uuid, p_hub text, p_limit int default 400,
  p_similar boolean default false, p_with text[] default '{}', p_tags boolean default false)
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
  if not exists (
    select 1 from map_hubs(p_lab_id) h where h.id = p_hub
    union all
    select 1 from map_tags(p_lab_id) t where p_hub like 'tag:%' and t.id = p_hub
  ) then
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
  v_hubs := array(
    select h.id from map_hubs(p_lab_id) h
    union all
    select t.id from map_tags(p_lab_id) t where p_tags or t.id = p_hub
  );
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

-- The map around one thing, as 0021; with p_tags, a file's tags are one step out (and a tag
-- reached that way shows its newest files a step further, as any hub does).
create function lab_map_local(p_lab_id uuid, p_node text, p_depth int default 1,
  p_similar boolean default false, p_tags boolean default false)
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
      select distinct s from map_step(p_lab_id, v_frontier, case step when 1 then 150 else 24 end, p_similar, p_tags) s
      where s <> all (v_nodes)
    );
    v_nodes := v_nodes || v_next;
    v_frontier := v_next;
  end loop;
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

-- Each member's view of their lab's map, so it opens as they left it: the camera (the hub
-- nearest the middle of the screen, how far from it and how far in; null is "fit the map"),
-- the hubs they had open, the kinds they hid and the two switches. Theirs alone: nobody else
-- in the lab reads it, and leaving the lab takes it away from them.
create table map_views (
  lab_id uuid not null references labs (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  camera jsonb check (
    camera is null or case
      when jsonb_typeof(camera) <> 'object' or not camera ?& array['anchor', 'k', 'dx', 'dy']
        or camera - array['anchor', 'k', 'dx', 'dy'] <> '{}'::jsonb
        or jsonb_typeof(camera -> 'anchor') <> 'string'
        or jsonb_typeof(camera -> 'k') <> 'number'
        or jsonb_typeof(camera -> 'dx') <> 'number'
        or jsonb_typeof(camera -> 'dy') <> 'number' then false
      else length(camera ->> 'anchor') <= 140
        and (camera ->> 'k')::numeric between 0.04 and 8
        and abs((camera ->> 'dx')::numeric) <= 100000
        and abs((camera ->> 'dy')::numeric) <= 100000
    end
  ),
  open_hubs text[] not null default '{}' check (cardinality(open_hubs) <= 200),
  hidden_kinds text[] not null default '{}'
    check (hidden_kinds <@ array['protocol', 'experiment', 'person', 'instrument', 'file']),
  show_similar boolean not null default false,
  show_tags boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (lab_id, user_id)
);

alter table map_views enable row level security;
create policy map_views_select on map_views for select using (user_id = auth.uid() and is_lab_member(lab_id));
create policy map_views_insert on map_views for insert with check (user_id = auth.uid() and is_lab_member(lab_id));
create policy map_views_update on map_views for update
  using (user_id = auth.uid() and is_lab_member(lab_id)) with check (user_id = auth.uid() and is_lab_member(lab_id));

-- Saves the caller's view of a lab's map. Runs as the caller, so RLS keeps it to their own
-- row in a lab they belong to; saving the same view twice changes nothing but the time. A
-- null p_open (a map around one thing saves only its switches) keeps the camera and the open
-- hubs as they were.
create function save_map_view(p_lab_id uuid, p_camera jsonb, p_open text[], p_hidden text[],
  p_similar boolean, p_tags boolean) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  insert into map_views as v (lab_id, user_id, camera, open_hubs, hidden_kinds, show_similar, show_tags)
  values (p_lab_id, auth.uid(), case when p_open is not null then p_camera end, coalesce(p_open, '{}'),
    coalesce(p_hidden, '{}'), p_similar, p_tags)
  on conflict (lab_id, user_id) do update set
    camera = case when p_open is null then v.camera else excluded.camera end,
    open_hubs = case when p_open is null then v.open_hubs else excluded.open_hubs end,
    hidden_kinds = excluded.hidden_kinds,
    show_similar = excluded.show_similar, show_tags = excluded.show_tags, updated_at = now();
end
$$;

revoke all on map_views from anon, authenticated;
grant select on map_views to authenticated;
grant insert (lab_id, user_id, camera, open_hubs, hidden_kinds, show_similar, show_tags) on map_views to authenticated;
grant update (camera, open_hubs, hidden_kinds, show_similar, show_tags, updated_at) on map_views to authenticated;

revoke all on function
  map_tag_links(uuid, text[]), map_tags(uuid), map_step(uuid, text[], int, boolean, boolean),
  lab_map(uuid, boolean, boolean), lab_map_hub(uuid, text, int, boolean, text[], boolean),
  lab_map_local(uuid, text, int, boolean, boolean), save_map_view(uuid, jsonb, text[], text[], boolean, boolean)
from public, anon, authenticated;
grant execute on function
  lab_map(uuid, boolean, boolean), lab_map_hub(uuid, text, int, boolean, text[], boolean),
  lab_map_local(uuid, text, int, boolean, boolean), save_map_view(uuid, jsonb, text[], text[], boolean, boolean)
to authenticated;
