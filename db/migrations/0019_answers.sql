-- Asking the lab (Phase 4): a question gets a written answer whose every sentence cites the
-- files, protocol versions or table cells it came from, and the AI may propose changes
-- (a new protocol version, label fixes) that wait for a person's approval.
--
-- Who writes what. The web server calls the model; what the model said reaches the database
-- only through record_answer and record_suggestion, which only the service role may call and
-- which insert questions, suggestions and model_calls rows, nothing else. Members never write
-- those tables. A suggestion changes lab data only when a member approves it, through the same
-- save_protocol and correct_label a person uses, as that member, in the same transaction.

-- A new enum value can't be used in the transaction that adds it. Only plpgsql bodies, which
-- aren't checked until they run, name these; SQL bodies compare purpose::text instead.
alter type audit_action add value if not exists 'question.ask';
alter type audit_action add value if not exists 'suggestion.create';
alter type audit_action add value if not exists 'suggestion.approve';
alter type audit_action add value if not exists 'suggestion.dismiss';
alter type model_call_purpose add value if not exists 'answer';
alter type model_call_purpose add value if not exists 'suggestion';

-- model_calls was keyed by the file a call read. A question reads no one file, so a call is
-- now keyed by its file or by a cache key: the sha256 of the question and the exact sources
-- it was shown (lib/answers.ts). The file key stays unique, so the worker's inserts are unchanged.
alter table model_calls drop constraint model_calls_pkey;
alter table model_calls alter column sha256 drop not null;
alter table model_calls add column cache_key text check (cache_key ~ '^[0-9a-f]{64}$');
alter table model_calls add constraint model_calls_one_input check ((sha256 is null) <> (cache_key is null));
create unique index model_calls_file_key on model_calls (lab_id, sha256, purpose, model, prompt_version);
create unique index model_calls_cache_key on model_calls (lab_id, purpose, model, prompt_version, cache_key)
  where cache_key is not null;

-- What a lab may spend on questions and suggestions in a calendar month (UTC). The PRD puts
-- Q&A at $10-30 a month for a lab of eight; label spend isn't counted, it follows the files.
alter table labs add column ai_monthly_cap_usd numeric(10, 2) not null default 25
  check (ai_monthly_cap_usd >= 0);

create type answer_outcome as enum ('answered', 'not_found');
create type answer_verdict as enum ('helpful', 'not_helpful');
create type suggestion_kind as enum ('protocol_edit', 'labels');
create type suggestion_state as enum ('open', 'approved', 'dismissed');

create table questions (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  asked_by uuid references auth.users (id) on delete set null,
  question text not null check (length(btrim(question)) between 1 and 300),
  outcome answer_outcome not null,
  -- {"sentences": [{"text", "citations": [{"source", "cell"}]}]}, after every citation was
  -- checked against the sources below; no sentences when nothing was found.
  answer jsonb not null check (jsonb_typeof(answer -> 'sentences') = 'array'),
  -- What retrieval found, as shown beside the answer and as the closest files when there's none.
  sources jsonb not null check (jsonb_typeof(sources) = 'array'),
  -- Citations to sources the model wasn't shown, and sentences left with no citation.
  dropped_citations int not null default 0 check (dropped_citations >= 0),
  dropped_sentences int not null default 0 check (dropped_sentences >= 0),
  -- Null when no model ran: nothing in the lab matched.
  model text,
  cached boolean not null default false,
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  latency_ms int check (latency_ms >= 0),
  asked_at timestamptz not null default now(),
  unique (id, lab_id)
);
create index questions_lab_at_idx on questions (lab_id, asked_at desc);

create table answer_feedback (
  question_id uuid not null,
  lab_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  verdict answer_verdict not null,
  at timestamptz not null default now(),
  primary key (question_id, user_id),
  foreign key (question_id, lab_id) references questions (id, lab_id) on delete cascade
);

create table suggestions (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  kind suggestion_kind not null,
  state suggestion_state not null default 'open',
  question_id uuid,
  requested_by uuid references auth.users (id) on delete set null,
  -- One line: what changes and why.
  summary text not null check (length(btrim(summary)) between 1 and 400),
  -- The sources that motivated it, shaped like questions.sources.
  sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'),
  model text not null,
  -- protocol_edit: the drafted version, a fork of base_version_id held here until approved.
  protocol_id uuid,
  base_version_id uuid,
  title text check (title is null or length(btrim(title)) between 1 and 200),
  body text check (body is null or length(body) <= 200000),
  note text check (note is null or length(btrim(note)) between 1 and 300),
  created_at timestamptz not null default now(),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  -- protocol_edit, approved: the version approval saved, and whether the member changed the draft.
  applied_version_id uuid,
  edited boolean,
  unique (id, lab_id),
  foreign key (question_id, lab_id) references questions (id, lab_id) on delete set null (question_id),
  foreign key (protocol_id, lab_id) references protocols (id, lab_id) on delete cascade,
  foreign key (base_version_id, protocol_id) references protocol_versions (id, protocol_id),
  foreign key (applied_version_id, protocol_id) references protocol_versions (id, protocol_id),
  check (case kind
    when 'protocol_edit' then protocol_id is not null and base_version_id is not null
      and title is not null and body is not null
    else protocol_id is null and base_version_id is null and title is null and body is null and note is null
  end),
  check ((state = 'open') = (decided_at is null)),
  check (applied_version_id is null or (state = 'approved' and kind = 'protocol_edit')),
  check ((edited is not null) = (state = 'approved'))
);
create index suggestions_lab_open_idx on suggestions (lab_id, created_at desc) where state = 'open';
create index suggestions_protocol_idx on suggestions (protocol_id) where protocol_id is not null;

-- One proposed label change per file. Only the fields set here move; the rest stay as they are
-- at approval time.
create table suggestion_labels (
  suggestion_id uuid not null,
  lab_id uuid not null,
  sha256 text not null references blobs (sha256),
  clean_name text check (clean_name is null or length(btrim(clean_name)) between 1 and 200),
  date date,
  experiment_id uuid,
  person_id uuid,
  reason text not null check (length(btrim(reason)) between 1 and 400),
  -- Set when approval applied it; null on an approved suggestion means it was left out.
  correction_id bigint references corrections (id) on delete set null,
  primary key (suggestion_id, sha256),
  foreign key (suggestion_id, lab_id) references suggestions (id, lab_id) on delete cascade,
  foreign key (experiment_id, lab_id) references experiments (id, lab_id) on delete cascade,
  foreign key (person_id, lab_id) references people (id, lab_id) on delete cascade,
  check (num_nonnulls(clean_name, date, experiment_id, person_id) > 0)
);
create index suggestion_labels_sha_idx on suggestion_labels (sha256);

alter table questions enable row level security;
alter table answer_feedback enable row level security;
alter table suggestions enable row level security;
alter table suggestion_labels enable row level security;

create policy questions_select on questions for select using (is_lab_member(lab_id));
create policy answer_feedback_select on answer_feedback for select using (is_lab_member(lab_id));
create policy answer_feedback_insert on answer_feedback for insert
  with check (is_lab_member(lab_id) and user_id = auth.uid());
create policy answer_feedback_update on answer_feedback for update
  using (user_id = auth.uid()) with check (is_lab_member(lab_id) and user_id = auth.uid());
create policy suggestions_select on suggestions for select using (is_lab_member(lab_id));
create policy suggestion_labels_select on suggestion_labels for select using (is_lab_member(lab_id));

-- A live member of a live lab, for the service-role functions, which have no auth.uid().
create function is_member_of(p_lab_id uuid, p_user_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members m join labs l on l.id = m.lab_id
    where m.lab_id = p_lab_id and m.user_id = p_user_id and l.deletion_requested_at is null
  )
$$;

-- Retrieval for a question, under the caller's RLS: the files search_files ranks first, each
-- with its best few chunks (never chunk 0, the name and path, which come with the location),
-- its label and, for a spreadsheet, where its parsed table is stored.
create function ask_context(
  p_lab_id uuid,
  p_query text,
  p_query_embedding vector(1024) default null,
  p_files int default 6,
  p_chunks int default 2
)
returns table (
  sha256 text,
  score double precision,
  file_kind file_kind,
  locations jsonb,
  label jsonb,
  excerpts jsonb,
  table_key text
)
language sql stable security invoker set search_path = public, extensions as $$
  with q as (select prefix_tsquery(p_query) as tsq),
  hits as (
    select h.* from search_files(p_lab_id, p_query, p_query_embedding, null, null, null, null, least(p_files, 12)) h
  )
  select h.sha256, h.score, h.file_kind, h.locations, h.label,
    coalesce((
      select jsonb_agg(jsonb_build_object('ord', c.ord, 'text', c.text) order by c.ord)
      from (
        select c.ord, c.text from chunks c, q
        where c.lab_id = p_lab_id and c.sha256 = h.sha256 and c.ord > 0
        order by
          (q.tsq is not null and c.tsv @@ q.tsq) desc,
          case when p_query_embedding is not null and c.embedding is not null
            then c.embedding <=> p_query_embedding end nulls last,
          c.ord
        limit least(p_chunks, 4)
      ) c
    ), '[]'::jsonb),
    (select dt.storage_key from data_tables dt
      where dt.lab_id = p_lab_id and dt.sha256 = h.sha256 and dt.state = 'ready')
  from hits h
  order by h.score desc, h.sha256
$$;

-- Matching protocols with their current text, for a question. Keyword match, like search.
create function ask_protocols(p_lab_id uuid, p_query text, p_limit int default 3)
returns table (protocol_id uuid, kind protocol_kind, title text, version int, version_id uuid, body text)
language sql stable security invoker set search_path = public as $$
  select p.id, p.kind, v.title, v.version, v.id, left(v.body, 12000)
  from search_protocols(p_lab_id, p_query, least(p_limit, 5)) s
  join protocols p on p.id = s.id
  join protocol_versions v on v.id = p.current_version_id
$$;

-- What the lab has spent on questions and suggestions this month, and its cap.
create function ai_budget(p_lab_id uuid)
returns table (cap_usd numeric, spent_usd numeric, resets_at timestamptz)
language sql stable security definer set search_path = public as $$
  with m as (select date_trunc('month', now() at time zone 'utc') at time zone 'utc' as start)
  select l.ai_monthly_cap_usd,
    coalesce((
      select sum(c.cost_usd) from model_calls c
      where c.lab_id = l.id and c.purpose::text in ('answer', 'suggestion') and c.created_at >= m.start
    ), 0),
    m.start + interval '1 month'
  from labs l, m
  where l.id = p_lab_id and is_lab_member(p_lab_id)
$$;

-- A cached model answer for this lab and input, or nothing. Service role only.
create function cached_model_output(
  p_lab_id uuid,
  p_purpose text,
  p_cache_key text,
  p_model text,
  p_prompt_version int
)
returns jsonb
language sql stable security definer set search_path = public as $$
  select c.output from model_calls c
  where c.lab_id = p_lab_id and c.purpose::text = p_purpose and c.cache_key = p_cache_key
    and c.model = p_model and c.prompt_version = p_prompt_version
$$;

-- The ledger row for one paid call: {model, prompt_version, cache_key, output, input_tokens,
-- output_tokens, cache_read_tokens, cache_write_tokens, cost_usd}. Returns its cost.
create function record_model_call(p_lab_id uuid, p_purpose text, p_call jsonb) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  v_cost numeric := coalesce((p_call ->> 'cost_usd')::numeric, 0);
begin
  insert into model_calls (lab_id, cache_key, purpose, model, prompt_version, output,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
  values (
    p_lab_id, p_call ->> 'cache_key', p_purpose::model_call_purpose, p_call ->> 'model',
    (p_call ->> 'prompt_version')::int, p_call -> 'output',
    (p_call ->> 'input_tokens')::int, (p_call ->> 'output_tokens')::int,
    coalesce((p_call ->> 'cache_read_tokens')::int, 0), coalesce((p_call ->> 'cache_write_tokens')::int, 0),
    v_cost
  )
  on conflict do nothing;
  -- A second identical call, from two members asking at once, keeps the first answer but
  -- still cost money: it goes on the ledger under its own key.
  if not found then
    insert into model_calls (lab_id, cache_key, purpose, model, prompt_version, output,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
    values (
      p_lab_id, encode(sha256(convert_to(gen_random_uuid()::text, 'utf8')), 'hex'),
      p_purpose::model_call_purpose, p_call ->> 'model', (p_call ->> 'prompt_version')::int,
      jsonb_build_object('duplicate_of', p_call ->> 'cache_key'),
      (p_call ->> 'input_tokens')::int, (p_call ->> 'output_tokens')::int,
      coalesce((p_call ->> 'cache_read_tokens')::int, 0), coalesce((p_call ->> 'cache_write_tokens')::int, 0),
      v_cost
    );
  end if;
  return v_cost;
end
$$;

-- Saves one asked question and its checked answer, with the paid call when one was made
-- (p_call null: a cached answer, or nothing to ask about). Service role only.
create function record_answer(
  p_lab_id uuid,
  p_user_id uuid,
  p_question text,
  p_outcome answer_outcome,
  p_answer jsonb,
  p_sources jsonb,
  p_dropped_citations int,
  p_dropped_sentences int,
  p_model text,
  p_cached boolean,
  p_latency_ms int,
  p_call jsonb
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_cost numeric := 0;
begin
  if not is_member_of(p_lab_id, p_user_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  if p_call is not null then
    v_cost := record_model_call(p_lab_id, 'answer', p_call);
  end if;
  insert into questions (lab_id, asked_by, question, outcome, answer, sources, dropped_citations,
    dropped_sentences, model, cached, cost_usd, latency_ms)
  values (p_lab_id, p_user_id, btrim(p_question), p_outcome, p_answer, p_sources, p_dropped_citations,
    p_dropped_sentences, p_model, p_cached, v_cost, p_latency_ms)
  returning id into v_id;
  insert into audit_log (lab_id, actor, action, target) values (p_lab_id, p_user_id, 'question.ask', v_id::text);
  return v_id;
end
$$;

-- Saves what the model proposed as an open suggestion, and nothing else: no protocol version,
-- no correction. p_labels is [{sha256, clean_name, date, experiment_id, person_id, reason}].
-- Service role only. Errors: BL603 a file isn't a labeled file in this lab, BL103 no such
-- protocol or version, BL102 the protocol is archived.
create function record_suggestion(
  p_lab_id uuid,
  p_user_id uuid,
  p_kind suggestion_kind,
  p_question_id uuid,
  p_summary text,
  p_sources jsonb,
  p_protocol_id uuid,
  p_base_version_id uuid,
  p_title text,
  p_body text,
  p_note text,
  p_labels jsonb,
  p_model text,
  p_call jsonb
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  item jsonb;
begin
  if not is_member_of(p_lab_id, p_user_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  if p_question_id is not null and not exists (
    select 1 from questions q where q.id = p_question_id and q.lab_id = p_lab_id
  ) then
    raise exception 'no such question' using errcode = '22023';
  end if;
  if p_kind = 'protocol_edit' then
    if not exists (
      select 1 from protocols p join protocol_versions v on v.protocol_id = p.id
      where p.id = p_protocol_id and p.lab_id = p_lab_id and v.id = p_base_version_id
    ) then
      raise exception 'no such protocol' using errcode = 'BL103';
    end if;
    if exists (select 1 from protocols p where p.id = p_protocol_id and p.archived_at is not null) then
      raise exception 'this page is archived' using errcode = 'BL102';
    end if;
  elsif jsonb_typeof(p_labels) <> 'array' or jsonb_array_length(p_labels) = 0 then
    raise exception 'a label suggestion names at least one file' using errcode = '22023';
  end if;
  if p_call is not null then
    perform record_model_call(p_lab_id, 'suggestion', p_call);
  end if;
  insert into suggestions (lab_id, kind, question_id, requested_by, summary, sources, model,
    protocol_id, base_version_id, title, body, note)
  values (p_lab_id, p_kind, p_question_id, p_user_id, btrim(p_summary), coalesce(p_sources, '[]'), p_model,
    p_protocol_id, p_base_version_id, btrim(p_title), p_body, nullif(btrim(p_note), ''))
  returning id into v_id;
  if p_kind = 'labels' then
    for item in select * from jsonb_array_elements(p_labels) loop
      -- A file with no name yet (Needs a look) can only take a change that names it.
      if not exists (
        select 1 from labels l
        where l.lab_id = p_lab_id and l.sha256 = item ->> 'sha256'
          and (l.clean_name is not null or nullif(btrim(item ->> 'clean_name'), '') is not null)
          and exists (select 1 from file_locations fl
            where fl.lab_id = p_lab_id and fl.sha256 = l.sha256 and fl.deleted_at is null)
      ) then
        raise exception 'no such labeled file in this lab' using errcode = 'BL603';
      end if;
      insert into suggestion_labels (suggestion_id, lab_id, sha256, clean_name, date, experiment_id, person_id, reason)
      values (v_id, p_lab_id, item ->> 'sha256', nullif(btrim(item ->> 'clean_name'), ''),
        (item ->> 'date')::date, (item ->> 'experiment_id')::uuid, (item ->> 'person_id')::uuid,
        btrim(item ->> 'reason'));
    end loop;
  end if;
  insert into audit_log (lab_id, actor, action, target) values (p_lab_id, p_user_id, 'suggestion.create', v_id::text);
  return v_id;
end
$$;

-- Marks an open suggestion approved once the caller has made its change in this transaction:
-- a protocol version they saved on the suggested protocol, or label corrections they made.
-- Errors: BL601 not open (decided already, or not yours to see).
create function settle_suggestion(p_id uuid, p_version_id uuid, p_edited boolean, p_corrections jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  s suggestions;
  item jsonb;
begin
  select * into s from suggestions where id = p_id and state = 'open' and is_lab_member(lab_id) for update;
  if not found then
    raise exception 'this suggestion was already decided' using errcode = 'BL601';
  end if;
  if s.kind = 'protocol_edit' then
    if not exists (
      select 1 from protocol_versions v
      where v.id = p_version_id and v.protocol_id = s.protocol_id and v.based_on = s.base_version_id
        and v.author = auth.uid() and v.created_at = now()
    ) then
      raise exception 'approve through approve_protocol_suggestion' using errcode = '42501';
    end if;
  else
    if p_version_id is not null or jsonb_typeof(p_corrections) <> 'array' or jsonb_array_length(p_corrections) = 0 then
      raise exception 'approve through approve_label_suggestion' using errcode = '42501';
    end if;
    for item in select * from jsonb_array_elements(p_corrections) loop
      update suggestion_labels sl set correction_id = c.id
      from corrections c
      where sl.suggestion_id = p_id and sl.sha256 = item ->> 'sha256' and sl.correction_id is null
        and c.id = (item ->> 'correction_id')::bigint and c.sha256 = sl.sha256 and c.lab_id = sl.lab_id
        and c.user_id = auth.uid() and c.at = now();
      if not found then
        raise exception 'approve through approve_label_suggestion' using errcode = '42501';
      end if;
    end loop;
  end if;
  update suggestions set state = 'approved', decided_by = auth.uid(), decided_at = now(),
    applied_version_id = p_version_id, edited = coalesce(p_edited, false)
  where id = p_id;
  insert into audit_log (lab_id, actor, action, target) values (s.lab_id, auth.uid(), 'suggestion.approve', p_id::text);
end
$$;

-- Approving a protocol edit saves it as the caller's next version on top of the version it was
-- drafted from, through save_protocol, so a save by anyone since fails with BL101. Title, body
-- and note may be the member's own edit of the draft; null keeps the draft's.
create function approve_protocol_suggestion(p_id uuid, p_title text default null, p_body text default null, p_note text default null)
returns table (protocol_id uuid, version_id uuid, version int)
language plpgsql security invoker set search_path = public as $$
declare
  s suggestions;
  v_protocol uuid;
  v_version uuid;
  v_number int;
  v_title text;
  v_body text;
  v_note text;
begin
  select * into s from suggestions where id = p_id and kind = 'protocol_edit' and state = 'open';
  if not found then
    raise exception 'this suggestion was already decided' using errcode = 'BL601';
  end if;
  v_title := coalesce(p_title, s.title);
  v_body := coalesce(p_body, s.body);
  v_note := coalesce(p_note, s.note);
  select r.protocol_id, r.version_id, r.version into v_protocol, v_version, v_number
  from save_protocol(s.protocol_id, s.base_version_id, v_title, v_body, v_note) r;
  perform settle_suggestion(p_id, v_version,
    btrim(v_title) is distinct from btrim(s.title) or v_body is distinct from s.body, null);
  return query select v_protocol, v_version, v_number;
end
$$;

-- Approving label changes applies the chosen files' changes as the caller's corrections, each
-- on top of the label as it is now; the files left out stay as they are. Errors: BL601, BL602
-- (a chosen file isn't in the suggestion), and correct_label's own.
create function approve_label_suggestion(p_id uuid, p_shas text[])
returns table (sha256 text, correction_id bigint)
language plpgsql security invoker set search_path = public as $$
declare
  s suggestions;
  item suggestion_labels;
  cur labels;
  v_correction bigint;
  done jsonb := '[]';
begin
  select * into s from suggestions where id = p_id and kind = 'labels' and state = 'open';
  if not found then
    raise exception 'this suggestion was already decided' using errcode = 'BL601';
  end if;
  if coalesce(cardinality(p_shas), 0) = 0 or exists (
    select 1 from unnest(p_shas) x
    where not exists (select 1 from suggestion_labels sl where sl.suggestion_id = p_id and sl.sha256 = x)
  ) then
    raise exception 'pick files from this suggestion' using errcode = 'BL602';
  end if;
  for item in select * from suggestion_labels sl where sl.suggestion_id = p_id and sl.sha256 = any (p_shas) order by sl.sha256 loop
    select * into cur from labels l where l.lab_id = s.lab_id and l.sha256 = item.sha256;
    select c.correction_id into v_correction
    from correct_label(s.lab_id, item.sha256,
      coalesce(item.clean_name, cur.clean_name), coalesce(item.date, cur.date),
      coalesce(item.experiment_id, cur.experiment_id), coalesce(item.person_id, cur.person_id),
      cur.instrument, cur.tags) c;
    done := done || jsonb_build_object('sha256', item.sha256, 'correction_id', v_correction);
    sha256 := item.sha256;
    correction_id := v_correction;
    return next;
  end loop;
  perform settle_suggestion(p_id, null, cardinality(p_shas) <
    (select count(*) from suggestion_labels sl where sl.suggestion_id = p_id), done);
end
$$;

create function dismiss_suggestion(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_lab uuid;
begin
  update suggestions set state = 'dismissed', decided_by = auth.uid(), decided_at = now()
  where id = p_id and state = 'open' and is_lab_member(lab_id)
  returning lab_id into v_lab;
  if not found then
    raise exception 'this suggestion was already decided' using errcode = 'BL601';
  end if;
  insert into audit_log (lab_id, actor, action, target) values (v_lab, auth.uid(), 'suggestion.dismiss', p_id::text);
end
$$;

create function give_answer_feedback(p_question_id uuid, p_verdict answer_verdict) returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_lab uuid;
begin
  select q.lab_id into v_lab from questions q where q.id = p_question_id;
  if not found then
    raise exception 'no such question' using errcode = '22023';
  end if;
  insert into answer_feedback (question_id, lab_id, user_id, verdict)
  values (p_question_id, v_lab, auth.uid(), p_verdict)
  on conflict (question_id, user_id) do update set verdict = excluded.verdict, at = now();
end
$$;

-- The lab's latest questions, with who asked (members can't read auth.users) and the
-- caller's own feedback.
create function recent_questions(p_lab_id uuid, p_limit int default 10)
returns table (
  id uuid,
  question text,
  outcome answer_outcome,
  asked_by uuid,
  asked_by_email text,
  asked_at timestamptz,
  my_verdict answer_verdict
)
language sql stable security definer set search_path = public as $$
  select q.id, q.question, q.outcome, q.asked_by, u.email::text, q.asked_at, f.verdict
  from questions q
  left join auth.users u on u.id = q.asked_by
  left join answer_feedback f on f.question_id = q.id and f.user_id = auth.uid()
  where q.lab_id = p_lab_id and is_lab_member(p_lab_id)
  order by q.asked_at desc, q.id
  limit least(p_limit, 50)
$$;

alter function ask_context(uuid, text, vector, int, int) set client_min_messages = warning;
alter function ask_protocols(uuid, text, int) set client_min_messages = warning;

revoke all on questions, answer_feedback, suggestions, suggestion_labels from anon, authenticated;
revoke all on function
  is_member_of(uuid, uuid),
  ask_context(uuid, text, vector, int, int), ask_protocols(uuid, text, int), ai_budget(uuid),
  cached_model_output(uuid, text, text, text, int), record_model_call(uuid, text, jsonb),
  record_answer(uuid, uuid, text, answer_outcome, jsonb, jsonb, int, int, text, boolean, int, jsonb),
  record_suggestion(uuid, uuid, suggestion_kind, uuid, text, jsonb, uuid, uuid, text, text, text, jsonb, text, jsonb),
  settle_suggestion(uuid, uuid, boolean, jsonb), approve_protocol_suggestion(uuid, text, text, text),
  approve_label_suggestion(uuid, text[]), dismiss_suggestion(uuid),
  give_answer_feedback(uuid, answer_verdict), recent_questions(uuid, int)
from public, anon, authenticated;

grant select on questions, suggestions, suggestion_labels to authenticated;
grant select on answer_feedback to authenticated;
grant insert (question_id, lab_id, user_id, verdict) on answer_feedback to authenticated;
grant update (verdict, at) on answer_feedback to authenticated;
grant execute on function
  ask_context(uuid, text, vector, int, int), ask_protocols(uuid, text, int), ai_budget(uuid),
  settle_suggestion(uuid, uuid, boolean, jsonb), approve_protocol_suggestion(uuid, text, text, text),
  approve_label_suggestion(uuid, text[]), dismiss_suggestion(uuid),
  give_answer_feedback(uuid, answer_verdict), recent_questions(uuid, int)
to authenticated;
-- What the model said reaches the lab only through these, and only from our server.
grant execute on function
  cached_model_output(uuid, text, text, text, int),
  record_answer(uuid, uuid, text, answer_outcome, jsonb, jsonb, int, int, text, boolean, int, jsonb),
  record_suggestion(uuid, uuid, suggestion_kind, uuid, text, jsonb, uuid, uuid, text, text, text, jsonb, text, jsonb)
to service_role;
