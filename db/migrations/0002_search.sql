-- Words of two or more characters, each as a prefix, OR-ed so ranking rather than
-- an all-words rule decides; "P450 gels" becomes 'p450':* | 'gel':*.
create function prefix_tsquery(p_query text) returns tsquery
language sql immutable set search_path = public as $$
  select case when count(*) = 0 then null
    else to_tsquery('english', string_agg(quote_literal(w) || ':*', ' | '))
  end
  from regexp_split_to_table(lower(coalesce(p_query, '')), '[^[:alnum:]]+') as w
  where length(w) >= 2
$$;

create function search_files(
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
  keyword_hits as (
    select c.sha256, ts_rank_cd(c.tsv, q.tsq) as r
    from chunks c, q
    where q.tsq is not null and c.lab_id = p_lab_id and c.tsv @@ q.tsq
      and c.sha256 in (select e.sha256 from eligible e)
    union all
    select l.sha256, ts_rank_cd(l.name_tsv, q.tsq) as r
    from live l, q
    where q.tsq is not null and l.name_tsv @@ q.tsq
  ),
  keyword as (
    select k.sha256, row_number() over (order by max(k.r) desc, k.sha256) as rank
    from keyword_hits k
    group by k.sha256
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

revoke all on function prefix_tsquery(text) from public, anon;
revoke all on function search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int)
  from public, anon;
grant execute on function prefix_tsquery(text) to authenticated;
grant execute on function search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int)
  to authenticated;
