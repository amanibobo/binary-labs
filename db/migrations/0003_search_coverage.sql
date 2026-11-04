-- Names like batch3 or plate07 also index as "batch 3" and "plate 07", so a query
-- that spells the number separately still matches the folder.
alter table file_locations drop column name_tsv;
alter table file_locations add column name_tsv tsvector generated always as (
  to_tsvector('english',
    regexp_replace(path, '[_./\\-]+', ' ', 'g') || ' ' ||
    regexp_replace(regexp_replace(path, '[_./\\-]+', ' ', 'g'), '([[:alpha:]])([[:digit:]])', '\1 \2', 'g'))
) stored;
create index file_locations_name_tsv_idx on file_locations using gin (name_tsv);

-- Words of two or more characters match as prefixes; bare numbers of any length match
-- exactly, because "3":* would also match 30 and 300.
create or replace function query_term_text(p_query text) returns setof text
language sql immutable set search_path = public as $$
  select distinct case when w ~ '^[0-9]+$' then quote_literal(w) else quote_literal(w) || ':*' end
  from regexp_split_to_table(lower(coalesce(p_query, '')), '[^[:alnum:]]+') as w
  where w ~ '^[0-9]+$' or length(w) >= 2
$$;

create or replace function prefix_tsquery(p_query text) returns tsquery
language sql immutable set search_path = public as $$
  select case when count(*) = 0 then null else to_tsquery('english', string_agg(t, ' | ')) end
  from query_term_text(p_query) as t
$$;

create or replace function search_files(
  p_lab_id uuid,
  p_query text,
  p_query_embedding vector(1024) default null,
  p_file_kinds file_kind[] default null,
  p_path_prefix text default null,
  p_modified_from timestamptz default null,
  p_modified_to timestamptz default null,
  p_limit int default 20
)
returns table (
  sha256 text,
  score double precision,
  keyword_rank int,
  vector_rank int,
  snippet text,
  file_kind file_kind,
  mime text,
  size bigint,
  has_preview boolean,
  locations jsonb
)
language sql stable security invoker set search_path = public, extensions as $$
  with q as (select prefix_tsquery(p_query) as tsq),
  terms as (
    select t.tq from (select to_tsquery('english', s) as tq from query_term_text(p_query) as s) t
    where numnode(t.tq) > 0
  ),
  live as (
    select fl.id, fl.sha256, fl.source_id, fl.path, fl.original_name, fl.modified_at, fl.name_tsv
    from file_locations fl
    join blobs b on b.sha256 = fl.sha256
    where fl.lab_id = p_lab_id
      and fl.deleted_at is null
      and fl.index_state = 'indexed'
      and (p_file_kinds is null or b.file_kind = any (p_file_kinds))
      and (p_path_prefix is null or starts_with(lower(fl.path), lower(p_path_prefix)))
      and (p_modified_from is null or fl.modified_at >= p_modified_from)
      and (p_modified_to is null or fl.modified_at < p_modified_to)
  ),
  eligible as (select distinct live.sha256 from live),
  keyword_docs as (
    select c.sha256, c.tsv
    from chunks c, q
    where q.tsq is not null and c.lab_id = p_lab_id and c.tsv @@ q.tsq
      and c.sha256 in (select e.sha256 from eligible e)
    union all
    select l.sha256, l.name_tsv
    from live l, q
    where q.tsq is not null and l.name_tsv @@ q.tsq
  ),
  -- A file that contains more of the query's words beats one that repeats a single word often.
  keyword as (
    select d.sha256,
      row_number() over (
        order by count(distinct t.tq) desc, max(ts_rank_cd(d.tsv, q.tsq, 1)) desc, d.sha256
      ) as rank
    from keyword_docs d
    cross join q
    join terms t on d.tsv @@ t.tq
    group by d.sha256
    order by rank
    limit 50
  ),
  vector_hits as (
    select c.sha256, c.embedding <=> p_query_embedding as d
    from chunks c
    where p_query_embedding is not null and c.lab_id = p_lab_id and c.embedding is not null
    order by c.embedding <=> p_query_embedding
    limit 200
  ),
  vector as (
    select v.sha256, row_number() over (order by min(v.d), v.sha256) as rank
    from vector_hits v
    where v.sha256 in (select e.sha256 from eligible e)
    group by v.sha256
    order by rank
    limit 50
  ),
  fused as (
    select coalesce(k.sha256, v.sha256) as sha256,
      coalesce(1.0 / (60 + k.rank), 0) + coalesce(1.0 / (60 + v.rank), 0) as score,
      k.rank::int as keyword_rank,
      v.rank::int as vector_rank
    from keyword k
    full outer join vector v on v.sha256 = k.sha256
  )
  select f.sha256,
    f.score::double precision,
    f.keyword_rank,
    f.vector_rank,
    (
      select c.text from chunks c, q
      where c.lab_id = p_lab_id and c.sha256 = f.sha256
      order by
        (q.tsq is not null and c.tsv @@ q.tsq) desc,
        (c.ord = 0),
        case when p_query_embedding is not null and c.embedding is not null
          then c.embedding <=> p_query_embedding end nulls last,
        c.ord
      limit 1
    ) as snippet,
    b.file_kind,
    b.mime,
    b.size,
    exists (select 1 from previews p where p.lab_id = p_lab_id and p.sha256 = f.sha256) as has_preview,
    (
      select jsonb_agg(jsonb_build_object(
        'id', l.id,
        'source_id', l.source_id,
        'source_kind', s.kind,
        'path', l.path,
        'original_name', l.original_name,
        'modified_at', l.modified_at
      ) order by l.modified_at desc)
      from live l join sources s on s.id = l.source_id
      where l.sha256 = f.sha256
    ) as locations
  from fused f
  join blobs b on b.sha256 = f.sha256
  order by f.score desc, f.sha256
  limit p_limit
$$;

revoke all on function query_term_text(text) from public, anon;
grant execute on function query_term_text(text) to authenticated;

-- to_tsquery raises a NOTICE for every stop word ("from", "the"); keep searches quiet.
alter function prefix_tsquery(text) set client_min_messages = warning;
alter function search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int)
  set client_min_messages = warning;
