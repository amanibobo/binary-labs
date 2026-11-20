-- Search filters by a label's outcome and by Check this, and a list of the lab's old questions
-- (decisions.md, "search filters and old questions").
--
-- search_files gains two filters, appended after p_limit so callers passing eight arguments
-- (ask_context, the worker's eval) keep working: p_outcomes keeps files whose label has one of
-- those outcomes (never one in Needs a look, which shows none), and p_check_only keeps files
-- whose label says Check this. A note's pages are judged by its first page's label, the one
-- its row shows, so a note passes or fails whole.
-- The body is 0025's with that one condition added where the other filters are.
drop function search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int);

create function search_files(
  p_lab_id uuid,
  p_query text,
  p_query_embedding vector(1024) default null,
  p_file_kinds file_kind[] default null,
  p_path_prefix text default null,
  p_modified_from timestamptz default null,
  p_modified_to timestamptz default null,
  p_limit int default 20,
  p_outcomes label_outcome[] default null,
  p_check_only boolean default false
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
  locations jsonb,
  label jsonb,
  matched_page int
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
      and ((p_outcomes is null and not p_check_only) or exists (
        select 1 from labels l
        where l.lab_id = p_lab_id
          and l.sha256 = coalesce(
            (select c.sha256 from note_pages np
              join note_pages c on c.note_id = np.note_id and c.live
              where np.lab_id = p_lab_id and np.sha256 = fl.sha256 and np.live
              order by c.position limit 1),
            fl.sha256)
          and (p_outcomes is null or (l.outcome = any (p_outcomes) and l.status <> 'needs_look'))
          and (not p_check_only or l.status = 'check')
      ))
  ),
  eligible as (select distinct live.sha256 from live),
  shown_labels as (
    select l.sha256, l.tsv, l.experiment_id, l.person_id
    from labels l, q
    where q.tsq is not null and l.lab_id = p_lab_id and l.status <> 'needs_look'
      and l.sha256 in (select e.sha256 from eligible e)
  ),
  keyword_docs as (
    select c.sha256, c.tsv
    from chunks c, q
    where q.tsq is not null and c.lab_id = p_lab_id and c.tsv @@ q.tsq
      and c.sha256 in (select e.sha256 from eligible e)
    union all
    select l.sha256, l.name_tsv
    from live l, q
    where q.tsq is not null and l.name_tsv @@ q.tsq
    union all
    select l.sha256, l.tsv from shown_labels l, q where l.tsv @@ q.tsq
    union all
    select l.sha256, e.tsv from shown_labels l join experiments e on e.id = l.experiment_id, q
    where e.tsv @@ q.tsq
    union all
    select l.sha256, p.tsv from shown_labels l join people p on p.id = l.person_id, q
    where p.tsv @@ q.tsq
  ),
  -- A note's words are spread over its pages and its first page's label, so its documents
  -- count together: a query with one word on page 3 and another on page 7 matches both.
  doc_owner as (
    select d.sha256, d.tsv, coalesce(cover.sha256, d.sha256) as owner
    from keyword_docs d
    left join note_pages np on np.lab_id = p_lab_id and np.sha256 = d.sha256 and np.live
    left join lateral (
      select c.sha256 from note_pages c where c.note_id = np.note_id and c.live order by c.position limit 1
    ) cover on true
  ),
  -- A file that contains more of the query's words beats one that repeats a single word often.
  keyword as (
    select d.owner as sha256,
      row_number() over (
        order by count(distinct t.tq) desc, max(ts_rank_cd(d.tsv, q.tsq, 1)) desc, d.owner
      ) as rank
    from doc_owner d
    cross join q
    join terms t on d.tsv @@ t.tq
    group by d.owner
    order by rank
    limit 50
  ),
  -- The page whose own text matches best, for the snippet and to open the note there.
  keyword_page as (
    select distinct on (d.owner) d.owner, d.sha256
    from doc_owner d cross join q
    join terms t on d.tsv @@ t.tq
    group by d.owner, d.sha256
    order by d.owner, count(distinct t.tq) desc, max(ts_rank_cd(d.tsv, q.tsq, 1)) desc, d.sha256
  ),
  vector_hits as (
    select c.sha256, c.embedding <=> p_query_embedding as d
    from chunks c
    where p_query_embedding is not null and c.lab_id = p_lab_id and c.embedding is not null
    order by c.embedding <=> p_query_embedding
    limit 200
  ),
  vector_owner as (
    select v.sha256, v.d, coalesce(cover.sha256, v.sha256) as owner
    from vector_hits v
    left join note_pages np on np.lab_id = p_lab_id and np.sha256 = v.sha256 and np.live
    left join lateral (
      select c.sha256 from note_pages c where c.note_id = np.note_id and c.live order by c.position limit 1
    ) cover on true
    where v.sha256 in (select e.sha256 from eligible e)
  ),
  vector as (
    select v.owner as sha256, row_number() over (order by min(v.d), v.owner) as rank,
      (array_agg(v.sha256 order by v.d))[1] as page
    from vector_owner v
    group by v.owner
    order by rank
    limit 50
  ),
  fused as (
    select coalesce(k.sha256, v.sha256) as sha256,
      coalesce(1.0 / (60 + k.rank), 0) + coalesce(1.0 / (60 + v.rank), 0) as score,
      k.rank::int as keyword_rank,
      v.rank::int as vector_rank,
      coalesce(kp.sha256, v.page, coalesce(k.sha256, v.sha256)) as page_sha
    from keyword k
    full outer join vector v on v.sha256 = k.sha256
    left join keyword_page kp on kp.owner = coalesce(k.sha256, v.sha256)
  )
  select f.sha256,
    f.score::double precision,
    f.keyword_rank,
    f.vector_rank,
    (
      select c.text from chunks c, q
      where c.lab_id = p_lab_id and c.sha256 = f.page_sha and c.ord > 0
      order by
        (q.tsq is not null and c.tsv @@ q.tsq) desc,
        case when p_query_embedding is not null and c.embedding is not null
          then c.embedding <=> p_query_embedding end nulls last,
        c.ord
      limit 1
    ) as snippet,
    b.file_kind,
    b.mime,
    b.size,
    exists (select 1 from previews p where p.lab_id = p_lab_id and p.sha256 = f.sha256) as has_preview,
    -- The places that passed the filters; a note's first page may not have, so then all of its.
    coalesce(
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
      ),
      live_locations_json(p_lab_id, f.sha256)
    ) as locations,
    label_json(p_lab_id, f.sha256) as label,
    (select np.position from note_pages np
      where np.lab_id = p_lab_id and np.sha256 = f.page_sha and np.live) as matched_page
  from fused f
  join blobs b on b.sha256 = f.sha256
  where exists (select 1 from file_locations l where l.lab_id = p_lab_id and l.sha256 = f.sha256 and l.deleted_at is null)
  order by f.score desc, f.sha256
  limit p_limit
$$;

alter function search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int, label_outcome[], boolean)
  set client_min_messages = warning;

-- The lab's questions, newest first, a page at a time: every word of p_query has to be in the
-- question or its answer (prefixes count, as in search), and p_before_at with p_before_id is
-- the last row of the page before. Security definer like recent_questions, for who asked.
create function search_questions(
  p_lab_id uuid,
  p_query text default null,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit int default 50
)
returns table (
  id uuid,
  question text,
  outcome answer_outcome,
  asked_by uuid,
  asked_by_email text,
  asked_at timestamptz
)
language sql stable security definer set search_path = public as $$
  with terms as (
    select t.tq from (select to_tsquery('english', s) as tq from query_term_text(p_query) as s) t
    where numnode(t.tq) > 0
  )
  select q.id, q.question, q.outcome, q.asked_by, u.email::text, q.asked_at
  from questions q
  left join auth.users u on u.id = q.asked_by
  where q.lab_id = p_lab_id and is_lab_member(p_lab_id)
    and (p_before_at is null or (q.asked_at, q.id) < (p_before_at, p_before_id))
    and not exists (
      select 1 from terms t
      where not to_tsvector('english', q.question || ' ' || coalesce(
        (select string_agg(s ->> 'text', ' ') from jsonb_array_elements(q.answer -> 'sentences') s), ''
      )) @@ t.tq
    )
  order by q.asked_at desc, q.id desc
  limit least(greatest(p_limit, 1), 100)
$$;

alter function search_questions(uuid, text, timestamptz, uuid, int) set client_min_messages = warning;

revoke all on function
  search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int, label_outcome[], boolean),
  search_questions(uuid, text, timestamptz, uuid, int)
from public, anon, authenticated;
grant execute on function
  search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int, label_outcome[], boolean),
  search_questions(uuid, text, timestamptz, uuid, int)
to authenticated;
