-- Labels: suggested clean names and tags per (lab_id, sha256), the human corrections that
-- fix them, the experiments and people they point at, and the rules learned from corrections.

-- A new enum value can't be used in the transaction that adds it, so nothing below names it.
alter type extraction_kind add value if not exists 'image_caption';

create type label_status as enum ('suggested', 'check', 'needs_look', 'accepted', 'corrected');
create type label_rule_kind as enum ('folder_experiment', 'folder_person', 'name_template');
create type model_call_purpose as enum ('label', 'caption');

-- Path text the way search reads it: raw, separators spaced out, and "batch3" also as "batch 3".
create function searchable_text(p text) returns text
language sql immutable parallel safe set search_path = public as $$
  select coalesce(p, '') || ' ' || regexp_replace(regexp_replace(coalesce(p, ''), '[_./\\-]+', ' ', 'g'),
    '([[:alpha:]])([[:digit:]])', '\1 \2', 'g')
$$;

-- array_to_string is only stable, so generated columns can't call it directly; text[] to
-- text by a fixed separator doesn't depend on any setting.
create function joined_words(p text[]) returns text
language sql immutable parallel safe set search_path = public as $$
  select coalesce(array_to_string(p, ' '), '')
$$;

create table experiments (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 50),
  created_at timestamptz not null default now(),
  tsv tsvector generated always as (
    to_tsvector('english', searchable_text(name || ' ' || joined_words(aliases)))
  ) stored,
  unique (id, lab_id)
);
create unique index experiments_lab_name_idx on experiments (lab_id, lower(btrim(name)));

create table people (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  -- Initials and other spellings as they appear in folder and file names.
  aliases text[] not null default '{}' check (cardinality(aliases) <= 50),
  member_user_id uuid,
  created_at timestamptz not null default now(),
  tsv tsvector generated always as (
    to_tsvector('english', searchable_text(display_name || ' ' || joined_words(aliases)))
  ) stored,
  unique (id, lab_id),
  foreign key (lab_id, member_user_id) references members (lab_id, user_id)
    on delete set null (member_user_id)
);
create unique index people_lab_name_idx on people (lab_id, lower(btrim(display_name)));

create table labels (
  lab_id uuid not null references labs (id) on delete cascade,
  sha256 text not null references blobs (sha256),
  status label_status not null,
  clean_name text check (clean_name is null or length(btrim(clean_name)) between 1 and 200),
  date date,
  experiment_id uuid,
  person_id uuid,
  instrument text check (instrument is null or length(btrim(instrument)) between 1 and 120),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  confidence real not null check (confidence between 0 and 1),
  -- Who produced the current values: 'rules', a model id, or 'human'.
  source text not null,
  reason text,
  updated_at timestamptz not null default now(),
  tsv tsvector generated always as (
    to_tsvector('english',
      searchable_text(coalesce(clean_name, '') || ' ' || coalesce(instrument, '') || ' ' || joined_words(tags)))
  ) stored,
  primary key (lab_id, sha256),
  foreign key (experiment_id, lab_id) references experiments (id, lab_id) on delete set null (experiment_id),
  foreign key (person_id, lab_id) references people (id, lab_id) on delete set null (person_id),
  -- "Needs a look" means there is no label to show; every other state has a name.
  check ((status = 'needs_look') = (clean_name is null))
);
create index labels_tsv_idx on labels using gin (tsv);
create index labels_lab_status_idx on labels (lab_id, status);

create table corrections (
  id bigint generated always as identity primary key,
  lab_id uuid not null,
  sha256 text not null,
  user_id uuid references auth.users (id) on delete set null,
  -- Full label state before and after, filled in by corrections_apply; the client's
  -- `after` is only the requested fields.
  before jsonb not null default '{}',
  after jsonb not null,
  undoes bigint unique references corrections (id) on delete cascade,
  rule_learned jsonb,
  learned_at timestamptz,
  at timestamptz not null default now(),
  foreign key (lab_id, sha256) references labels (lab_id, sha256) on delete cascade
);
create index corrections_lab_at_idx on corrections (lab_id, at desc);
create index corrections_unlearned_idx on corrections (at) where learned_at is null;

create table label_rules (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  kind label_rule_kind not null,
  -- Lowercased folder path; the rule covers files in it and below it.
  folder text not null check (folder ~ '^/'),
  -- name_template only: the file name with digit runs as '#', and the clean name with
  -- {0}, {1}... standing for those digit runs.
  name_skeleton text not null default '',
  template text,
  experiment_id uuid,
  person_id uuid,
  correction_id bigint not null references corrections (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (lab_id, kind, folder, name_skeleton),
  foreign key (experiment_id, lab_id) references experiments (id, lab_id) on delete cascade,
  foreign key (person_id, lab_id) references people (id, lab_id) on delete cascade,
  check (case kind
    when 'folder_experiment' then experiment_id is not null and person_id is null and template is null
    when 'folder_person' then person_id is not null and experiment_id is null and template is null
    when 'name_template' then template is not null and name_skeleton <> ''
      and experiment_id is null and person_id is null
  end)
);

-- One row per model call: the cache (nothing is labeled twice for the same model and
-- prompt version) and the cost ledger.
create table model_calls (
  lab_id uuid not null references labs (id) on delete cascade,
  sha256 text not null references blobs (sha256),
  purpose model_call_purpose not null,
  model text not null,
  prompt_version int not null check (prompt_version > 0),
  output jsonb not null,
  input_tokens int not null check (input_tokens >= 0),
  output_tokens int not null check (output_tokens >= 0),
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  cost_usd numeric(12, 6) not null check (cost_usd >= 0),
  created_at timestamptz not null default now(),
  primary key (lab_id, sha256, purpose, model, prompt_version)
);

alter table experiments enable row level security;
alter table people enable row level security;
alter table labels enable row level security;
alter table corrections enable row level security;
alter table label_rules enable row level security;
alter table model_calls enable row level security;

create policy experiments_select on experiments for select using (is_lab_member(lab_id));
create policy experiments_insert on experiments for insert with check (is_lab_member(lab_id));
create policy experiments_update on experiments for update
  using (is_lab_member(lab_id)) with check (is_lab_member(lab_id));
create policy experiments_delete on experiments for delete using (is_lab_admin(lab_id));

create policy people_select on people for select using (is_lab_member(lab_id));
create policy people_insert on people for insert with check (is_lab_member(lab_id));
create policy people_update on people for update
  using (is_lab_member(lab_id)) with check (is_lab_member(lab_id));
create policy people_delete on people for delete using (is_lab_admin(lab_id));

create policy labels_select on labels for select using (is_lab_member(lab_id));
create policy corrections_select on corrections for select using (is_lab_member(lab_id));
create policy corrections_insert on corrections for insert
  with check (is_lab_member(lab_id) and user_id = auth.uid());
create policy label_rules_select on label_rules for select using (is_lab_member(lab_id));
create policy model_calls_select on model_calls for select using (is_lab_member(lab_id));

create function label_state(l labels) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'status', l.status,
    'clean_name', l.clean_name,
    'date', l.date,
    'experiment_id', l.experiment_id,
    'person_id', l.person_id,
    'instrument', l.instrument,
    'tags', to_jsonb(l.tags),
    'confidence', l.confidence,
    'source', l.source,
    'reason', l.reason
  )
$$;

-- Members never write labels directly: inserting a correction applies it, in the same
-- statement, as the signed-in user. A correction that changes nothing is an acceptance.
-- An undo restores the exact state its correction replaced, if nothing changed since.
-- Errors a person can cause carry their own codes: BL001 no label yet, BL002 nothing to
-- undo, BL003 already undone, BL004 changed since, BL005 someone else's change.
create function corrections_apply() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cur labels;
  target corrections;
  fields constant text[] := array['clean_name', 'date', 'experiment_id', 'person_id', 'instrument', 'tags'];
  wanted jsonb;
  v_name text;
  v_tags text[];
begin
  new.user_id := auth.uid();
  if new.user_id is null or not is_lab_member(new.lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  select * into cur from labels where lab_id = new.lab_id and sha256 = new.sha256 for update;
  if not found then
    raise exception 'no label for this file yet' using errcode = 'BL001';
  end if;
  new.before := label_state(cur);
  new.at := now();
  new.learned_at := null;
  new.rule_learned := null;

  if new.undoes is not null then
    select * into target from corrections where id = new.undoes;
    if not found or target.lab_id <> new.lab_id or target.sha256 <> new.sha256 or target.undoes is not null then
      raise exception 'nothing to undo' using errcode = 'BL002';
    end if;
    if exists (select 1 from corrections c where c.undoes = target.id) then
      raise exception 'already undone' using errcode = 'BL003';
    end if;
    if target.user_id is distinct from new.user_id then
      raise exception 'only the person who made a change can undo it' using errcode = 'BL005';
    end if;
    if target.after <> new.before then
      raise exception 'the label changed since; undo no longer applies' using errcode = 'BL004';
    end if;
    new.after := target.before;
    update labels set
      status = (target.before ->> 'status')::label_status,
      clean_name = target.before ->> 'clean_name',
      date = (target.before ->> 'date')::date,
      experiment_id = (target.before ->> 'experiment_id')::uuid,
      person_id = (target.before ->> 'person_id')::uuid,
      instrument = target.before ->> 'instrument',
      tags = array(select jsonb_array_elements_text(target.before -> 'tags')),
      confidence = (target.before ->> 'confidence')::real,
      source = target.before ->> 'source',
      reason = target.before ->> 'reason',
      updated_at = now()
    where lab_id = new.lab_id and sha256 = new.sha256;
    return new;
  end if;

  if jsonb_typeof(new.after) <> 'object' or not (new.after ?& fields) then
    raise exception 'a correction names every field: %', fields using errcode = '22023';
  end if;
  v_name := nullif(btrim(new.after ->> 'clean_name'), '');
  if v_name is null then
    raise exception 'a label needs a name' using errcode = '23514';
  end if;
  v_tags := array(
    select w.tag from (
      select btrim(t.value) as tag, min(t.ord) as first_at
      from jsonb_array_elements_text(new.after -> 'tags') with ordinality as t (value, ord)
      where btrim(t.value) <> ''
      group by 1
    ) w order by w.first_at
  );
  wanted := jsonb_build_object(
    'clean_name', v_name,
    'date', (new.after ->> 'date')::date,
    'experiment_id', (new.after ->> 'experiment_id')::uuid,
    'person_id', (new.after ->> 'person_id')::uuid,
    'instrument', nullif(btrim(new.after ->> 'instrument'), ''),
    'tags', to_jsonb(v_tags)
  );
  update labels set
    status = case
      when cur.status <> 'needs_look'
        and wanted = (select jsonb_object_agg(k, new.before -> k) from unnest(fields) k)
      then 'accepted'::label_status else 'corrected'::label_status end,
    clean_name = wanted ->> 'clean_name',
    date = (wanted ->> 'date')::date,
    experiment_id = (wanted ->> 'experiment_id')::uuid,
    person_id = (wanted ->> 'person_id')::uuid,
    instrument = wanted ->> 'instrument',
    tags = v_tags,
    confidence = 1,
    source = 'human',
    reason = null,
    updated_at = now()
  where lab_id = new.lab_id and sha256 = new.sha256
  returning * into cur;
  new.after := label_state(cur);
  return new;
end
$$;

create trigger corrections_apply before insert on corrections
  for each row execute function corrections_apply();

-- The one label shape the web app reads, from search, recent files and the queue.
create function label_json(p_lab_id uuid, p_sha256 text) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'status', l.status,
    'clean_name', l.clean_name,
    'date', l.date,
    'experiment', case when e.id is null then null
      else jsonb_build_object('id', e.id, 'name', e.name) end,
    'person', case when p.id is null then null
      else jsonb_build_object('id', p.id, 'name', p.display_name) end,
    'instrument', l.instrument,
    'tags', to_jsonb(l.tags),
    'confidence', l.confidence
  )
  from labels l
  left join experiments e on e.id = l.experiment_id
  left join people p on p.id = l.person_id
  where l.lab_id = p_lab_id and l.sha256 = p_sha256
$$;

create function correct_label(
  p_lab_id uuid,
  p_sha256 text,
  p_clean_name text,
  p_date date,
  p_experiment_id uuid,
  p_person_id uuid,
  p_instrument text,
  p_tags text[]
)
returns table (correction_id bigint, label jsonb)
language plpgsql security invoker set search_path = public as $$
declare
  v_id bigint;
begin
  insert into corrections (lab_id, sha256, after)
  values (p_lab_id, p_sha256, jsonb_build_object(
    'clean_name', p_clean_name,
    'date', p_date,
    'experiment_id', p_experiment_id,
    'person_id', p_person_id,
    'instrument', p_instrument,
    'tags', to_jsonb(coalesce(p_tags, '{}'))
  ))
  returning id into v_id;
  return query select v_id, label_json(p_lab_id, p_sha256);
end
$$;

create function undo_correction(p_correction_id bigint)
returns table (correction_id bigint, label jsonb)
language plpgsql security invoker set search_path = public as $$
declare
  v_id bigint;
  v_lab uuid;
  v_sha text;
begin
  select c.lab_id, c.sha256 into v_lab, v_sha from corrections c where c.id = p_correction_id;
  if not found then
    raise exception 'nothing to undo' using errcode = 'BL002';
  end if;
  insert into corrections (lab_id, sha256, after, undoes)
  values (v_lab, v_sha, '{}', p_correction_id)
  returning id into v_id;
  return query select v_id, label_json(v_lab, v_sha);
end
$$;

create function file_labels(p_lab_id uuid, p_shas text[])
returns table (sha256 text, label jsonb)
language sql stable security invoker set search_path = public as $$
  select l.sha256, label_json(p_lab_id, l.sha256)
  from labels l
  where l.lab_id = p_lab_id and l.sha256 = any (p_shas)
$$;

create function live_locations_json(p_lab_id uuid, p_sha256 text) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_agg(jsonb_build_object(
    'id', l.id,
    'source_id', l.source_id,
    'source_kind', s.kind,
    'path', l.path,
    'original_name', l.original_name,
    'modified_at', l.modified_at
  ) order by l.modified_at desc)
  from file_locations l join sources s on s.id = l.source_id
  where l.lab_id = p_lab_id and l.sha256 = p_sha256 and l.deleted_at is null
$$;

-- The Needs a look queue: files with no label to show, newest first. Unreadable files are
-- here too, since a person can still say what they are.
create function needs_look_files(p_lab_id uuid, p_limit int default 50)
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
  select l.sha256, b.file_kind, b.mime, b.size,
    exists (select 1 from previews p where p.lab_id = p_lab_id and p.sha256 = l.sha256),
    (select c.text from chunks c where c.lab_id = p_lab_id and c.sha256 = l.sha256 and c.ord = 1),
    live_locations_json(p_lab_id, l.sha256),
    label_json(p_lab_id, l.sha256)
  from labels l
  join blobs b on b.sha256 = l.sha256
  where l.lab_id = p_lab_id and l.status = 'needs_look'
    and exists (
      select 1 from file_locations fl
      where fl.lab_id = p_lab_id and fl.sha256 = l.sha256 and fl.deleted_at is null
    )
  order by l.updated_at desc, l.sha256
  limit p_limit
$$;

create function needs_look_count(p_lab_id uuid) returns bigint
language sql stable security invoker set search_path = public as $$
  select count(*) from labels l
  where l.lab_id = p_lab_id and l.status = 'needs_look'
    and exists (
      select 1 from file_locations fl
      where fl.lab_id = p_lab_id and fl.sha256 = l.sha256 and fl.deleted_at is null
    )
$$;

-- search_files gains a `label` column, so its return type changes and it has to be
-- dropped first. The body is 0003's, plus label text on the keyword side.
drop function search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int);

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
  locations jsonb,
  label jsonb
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
    ) as locations,
    label_json(p_lab_id, f.sha256) as label
  from fused f
  join blobs b on b.sha256 = f.sha256
  order by f.score desc, f.sha256
  limit p_limit
$$;

alter function search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int)
  set client_min_messages = warning;

revoke all on experiments, people, labels, corrections, label_rules, model_calls from anon, authenticated;
revoke all on function
  searchable_text(text), joined_words(text[]), label_state(labels), corrections_apply(),
  label_json(uuid, text),
  correct_label(uuid, text, text, date, uuid, uuid, text, text[]),
  undo_correction(bigint), file_labels(uuid, text[]), live_locations_json(uuid, text),
  needs_look_files(uuid, int), needs_look_count(uuid),
  search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int)
from public, anon, authenticated;

grant select (id, lab_id, name, aliases, created_at, tsv) on experiments to authenticated;
grant insert (lab_id, name, aliases) on experiments to authenticated;
grant update (name, aliases) on experiments to authenticated;
grant delete on experiments to authenticated;
grant select (id, lab_id, display_name, aliases, member_user_id, created_at, tsv) on people to authenticated;
grant insert (lab_id, display_name, aliases) on people to authenticated;
grant update (display_name, aliases) on people to authenticated;
grant delete on people to authenticated;
grant select (
  lab_id, sha256, status, clean_name, date, experiment_id, person_id, instrument, tags,
  confidence, source, updated_at, tsv
) on labels to authenticated;
grant select (id, lab_id, sha256, user_id, before, after, undoes, rule_learned, at) on corrections
  to authenticated;
grant insert (lab_id, sha256, after, undoes) on corrections to authenticated;
grant select on label_rules to authenticated;
grant execute on function
  searchable_text(text), joined_words(text[]), label_state(labels), label_json(uuid, text),
  correct_label(uuid, text, text, date, uuid, uuid, text, text[]),
  undo_correction(bigint), file_labels(uuid, text[]), live_locations_json(uuid, text),
  needs_look_files(uuid, int), needs_look_count(uuid),
  search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int)
to authenticated;
