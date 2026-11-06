-- Smart labels (decisions.md, "smart labels: outcomes, summaries, conditions and notes"):
-- every label gains an outcome, a one-line summary, the key conditions behind it, the kind of
-- note it is, two other titles when Binary is unsure, what it couldn't read, and one question
-- for a voice note that leaves its experiment or date open. Pages photographed or uploaded
-- together can be one note. Corrections record and undo every new field like the old ones,
-- and search reads the summary, conditions and outcome.

-- New enum values can't be used in the transaction that adds them; only function bodies
-- below name them, and those run later.
alter type model_call_purpose add value if not exists 'note';
alter type audit_action add value if not exists 'note.join';
alter type audit_action add value if not exists 'note.split';
alter type audit_action add value if not exists 'note.keep';
alter type audit_action add value if not exists 'note.remove_page';

create type label_outcome as enum ('worked', 'failed', 'repeat', 'final', 'unclear');
create type note_kind as enum (
  'experiment_notes', 'meeting_notes', 'reading_summary', 'lecture', 'protocol', 'data', 'image', 'other'
);
create type note_state as enum ('suggested', 'confirmed', 'split');
create type note_page_role as enum ('setup', 'readings', 'reflection', 'other');

-- The key facts behind a label, mirroring LabelCondition in apps/web/src/lib/domain.ts:
-- [{kind, what, value, unit}]. Conditions, samples and materials for runs; attendees and
-- decisions for meeting notes. Values are text so a range ("0.1–100") and "[unclear]" fit;
-- the worker never writes a number the file doesn't show.
create function label_conditions_ok(c jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(c) = 'array'
    and jsonb_array_length(c) <= 24
    and length(c::text) <= 6000
    and not exists (
      select 1 from jsonb_array_elements(c) e
      where not coalesce(
        jsonb_typeof(e) = 'object'
        and (select count(*) from jsonb_object_keys(e)) = 4
        and e ?& array['kind', 'what', 'value', 'unit']
        and e ->> 'kind' in ('condition', 'sample', 'material', 'attendee', 'decision')
        and jsonb_typeof(e -> 'what') = 'string' and length(btrim(e ->> 'what')) between 1 and 80
        and (jsonb_typeof(e -> 'value') = 'null'
          or (jsonb_typeof(e -> 'value') = 'string' and length(btrim(e ->> 'value')) between 1 and 80))
        and (jsonb_typeof(e -> 'unit') = 'null'
          or (jsonb_typeof(e -> 'unit') = 'string' and length(btrim(e ->> 'unit')) between 1 and 20)),
        false
      )
    ),
    false
  )
$$;

-- One question for a voice note, mirroring FollowUp in apps/web/src/lib/domain.ts:
-- {field: experiment | date, question, choices: [{label, value}]}, the value an experiment
-- id or a YYYY-MM-DD day.
create function label_follow_up_ok(f jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(f) = 'object'
    and f ->> 'field' in ('experiment', 'date')
    and jsonb_typeof(f -> 'question') = 'string' and length(btrim(f ->> 'question')) between 1 and 160
    and jsonb_typeof(f -> 'choices') = 'array'
    and jsonb_array_length(f -> 'choices') between 1 and 5
    and not exists (
      select 1 from jsonb_array_elements(f -> 'choices') e
      where not coalesce(
        jsonb_typeof(e) = 'object'
        and length(btrim(e ->> 'label')) between 1 and 80
        and case f ->> 'field'
          when 'date' then (e ->> 'value') ~ '^\d{4}-\d{2}-\d{2}$'
          else (e ->> 'value') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        end,
        false
      )
    ),
    false
  )
$$;

-- Up to p_max short, non-blank strings.
create function label_texts_ok(p text[], p_max int, p_len int) returns boolean
language sql immutable parallel safe as $$
  select coalesce(cardinality(p), 0) <= p_max
    and not exists (select 1 from unnest(p) a where length(btrim(a)) not between 1 and p_len)
$$;

-- The words search reads from a label beyond its name, instrument and tags: the outcome
-- ("failed run"), the kind of note, the summary and every condition. Declared immutable so
-- the generated column can call it; nothing it reads depends on a setting.
create function label_extra_words(
  p_outcome label_outcome, p_note_kind note_kind, p_summary text, p_conditions jsonb
) returns text
language sql immutable parallel safe set search_path = public as $$
  select concat_ws(' ',
    case p_outcome::text
      when 'worked' then 'worked run'
      when 'failed' then 'failed run'
      when 'repeat' then 'repeat run'
      when 'final' then 'final run'
      when 'unclear' then 'unclear run'
    end,
    replace(p_note_kind::text, '_', ' '),
    p_summary,
    (select string_agg(concat_ws(' ', e ->> 'what', e ->> 'value', e ->> 'unit'), ' ')
     from jsonb_array_elements(coalesce(p_conditions, '[]')) e)
  )
$$;

alter table labels
  add column outcome label_outcome,
  add column summary text check (summary is null or length(btrim(summary)) between 1 and 400),
  add column conditions jsonb not null default '[]' check (label_conditions_ok(conditions)),
  add column note_kind note_kind,
  -- Two other titles, offered under the name while the label says Check this.
  add column alternatives text[] not null default '{}' check (label_texts_ok(alternatives, 2, 200)),
  -- What Binary couldn't read, named ("the concentration on page 7").
  add column unclear text[] not null default '{}' check (label_texts_ok(unclear, 6, 200)),
  add column follow_up jsonb check (follow_up is null or label_follow_up_ok(follow_up)),
  -- The label prompt version that produced the machine fields; the re-label sweep reads it.
  add column prompt_version smallint;

-- The keyword side of search reads the new fields too.
alter table labels drop column tsv;
alter table labels add column tsv tsvector generated always as (
  to_tsvector('english', searchable_text(
    coalesce(clean_name, '') || ' ' || coalesce(instrument, '') || ' ' || joined_words(tags) || ' '
    || label_extra_words(outcome, note_kind, summary, conditions)))
) stored;
create index labels_tsv_idx on labels using gin (tsv);
create index labels_lab_version_idx on labels (lab_id, prompt_version);

-- Upload batches: the files one person picked and sent together.
alter table uploads add column batch_id uuid;
create index uploads_batch_idx on uploads (lab_id, batch_id) where batch_id is not null;

-- A note: pages that belong together (photos uploaded together, numbered pages in one
-- folder), shown as one row. Binary suggests; a person keeps, splits or joins. The note's
-- title, summary, outcome and conditions are the label of its first page, read across all
-- pages; every page stays its own file with its own label.
create table notes (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  state note_state not null default 'suggested',
  -- Why the pages were grouped, in plain words ("Uploaded together").
  reason text not null check (length(btrim(reason)) between 1 and 200),
  -- What they were grouped from ("batch:<id>", "folder:<path>", "join:<id>"), so a note
  -- someone split is never suggested again.
  origin text not null check (length(origin) between 1 and 600),
  -- The pages the note's label was read from, and the page that carries it, as the worker
  -- last labeled it. A split or a new first page sends the old one back to its own label.
  labeled_key text,
  labeled_cover text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lab_id, origin),
  unique (id, lab_id)
);

create table note_pages (
  note_id uuid not null,
  lab_id uuid not null,
  sha256 text not null references blobs (sha256),
  position int not null check (position between 1 and 500),
  role note_page_role not null default 'other',
  -- A split note keeps its pages, not live, so the split can be undone.
  live boolean not null default true,
  primary key (note_id, sha256),
  foreign key (note_id, lab_id) references notes (id, lab_id) on delete cascade
);
-- A file is a page of at most one live note.
create unique index note_pages_one_note_idx on note_pages (lab_id, sha256) where live;
create index note_pages_sha_idx on note_pages (sha256);

alter table notes enable row level security;
alter table note_pages enable row level security;
create policy notes_select on notes for select using (is_lab_member(lab_id));
create policy note_pages_select on note_pages for select using (is_lab_member(lab_id));

-- The note a file is a page of, with every page in order, or null.
create function note_json(p_lab_id uuid, p_sha256 text) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'id', n.id,
    'state', n.state,
    'reason', n.reason,
    'position', me.position,
    'pages', (
      select jsonb_agg(jsonb_build_object(
        'sha256', p.sha256,
        'position', p.position,
        'role', p.role,
        'has_preview', exists (select 1 from previews pr where pr.lab_id = p_lab_id and pr.sha256 = p.sha256),
        'name', (select fl.original_name from file_locations fl
          where fl.lab_id = p_lab_id and fl.sha256 = p.sha256 and fl.deleted_at is null
          order by fl.modified_at desc limit 1)
      ) order by p.position)
      from note_pages p where p.note_id = n.id and p.live
    )
  )
  from note_pages me join notes n on n.id = me.note_id
  where me.lab_id = p_lab_id and me.sha256 = p_sha256 and me.live
$$;

create or replace function label_state(l labels) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'status', l.status,
    'clean_name', l.clean_name,
    'date', l.date,
    'experiment_id', l.experiment_id,
    'person_id', l.person_id,
    'instrument', l.instrument,
    'tags', to_jsonb(l.tags),
    'outcome', l.outcome,
    'summary', l.summary,
    'conditions', l.conditions,
    'note_kind', l.note_kind,
    'alternatives', to_jsonb(l.alternatives),
    'unclear', to_jsonb(l.unclear),
    'follow_up', l.follow_up,
    'confidence', l.confidence,
    'source', l.source,
    'reason', l.reason
  )
$$;

-- 0004's trigger with the new fields. The six old fields are still named by every
-- correction; outcome, summary, conditions and note_kind are optional and stay as they are
-- when left out, so older callers (approving a label suggestion) keep working. A person's
-- correction clears what Binary was unsure of (the other titles and what it couldn't read),
-- and answers the voice note's question once the field it asked about is set. BL006 is a
-- condition list that isn't [{kind, what, value, unit}].
create or replace function corrections_apply() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cur labels;
  target corrections;
  fields constant text[] := array['clean_name', 'date', 'experiment_id', 'person_id', 'instrument', 'tags'];
  compared constant text[] := array['clean_name', 'date', 'experiment_id', 'person_id', 'instrument', 'tags',
    'outcome', 'summary', 'conditions', 'note_kind'];
  wanted jsonb;
  v_name text;
  v_tags text[];
  v_outcome label_outcome;
  v_summary text;
  v_conditions jsonb;
  v_note_kind note_kind;
  v_follow_up jsonb;
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
    -- A state recorded before these fields existed has none of them; they go back to empty.
    update labels set
      status = (target.before ->> 'status')::label_status,
      clean_name = target.before ->> 'clean_name',
      date = (target.before ->> 'date')::date,
      experiment_id = (target.before ->> 'experiment_id')::uuid,
      person_id = (target.before ->> 'person_id')::uuid,
      instrument = target.before ->> 'instrument',
      tags = array(select jsonb_array_elements_text(target.before -> 'tags')),
      outcome = (target.before ->> 'outcome')::label_outcome,
      summary = target.before ->> 'summary',
      conditions = coalesce(nullif(target.before -> 'conditions', 'null'), '[]'),
      note_kind = (target.before ->> 'note_kind')::note_kind,
      alternatives = array(select jsonb_array_elements_text(coalesce(nullif(target.before -> 'alternatives', 'null'), '[]'))),
      unclear = array(select jsonb_array_elements_text(coalesce(nullif(target.before -> 'unclear', 'null'), '[]'))),
      follow_up = nullif(target.before -> 'follow_up', 'null'),
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
  v_outcome := case when new.after ? 'outcome' then (new.after ->> 'outcome')::label_outcome else cur.outcome end;
  v_summary := case when new.after ? 'summary' then nullif(btrim(new.after ->> 'summary'), '') else cur.summary end;
  v_note_kind := case when new.after ? 'note_kind' then (new.after ->> 'note_kind')::note_kind else cur.note_kind end;
  v_conditions := case when new.after ? 'conditions' then coalesce(nullif(new.after -> 'conditions', 'null'), '[]') else cur.conditions end;
  if not label_conditions_ok(v_conditions) then
    raise exception 'conditions are a list of {kind, what, value, unit}' using errcode = 'BL006';
  end if;
  wanted := jsonb_build_object(
    'clean_name', v_name,
    'date', (new.after ->> 'date')::date,
    'experiment_id', (new.after ->> 'experiment_id')::uuid,
    'person_id', (new.after ->> 'person_id')::uuid,
    'instrument', nullif(btrim(new.after ->> 'instrument'), ''),
    'tags', to_jsonb(v_tags),
    'outcome', v_outcome,
    'summary', v_summary,
    'conditions', v_conditions,
    'note_kind', v_note_kind
  );
  v_follow_up := case
    when cur.follow_up is null then null
    when cur.follow_up ->> 'field' = 'experiment' and wanted ->> 'experiment_id' is not null then null
    when cur.follow_up ->> 'field' = 'date' and wanted ->> 'date' is not null then null
    else cur.follow_up
  end;
  update labels set
    status = case
      when cur.status <> 'needs_look'
        and wanted = (select jsonb_object_agg(k, new.before -> k) from unnest(compared) k)
      then 'accepted'::label_status else 'corrected'::label_status end,
    clean_name = wanted ->> 'clean_name',
    date = (wanted ->> 'date')::date,
    experiment_id = (wanted ->> 'experiment_id')::uuid,
    person_id = (wanted ->> 'person_id')::uuid,
    instrument = wanted ->> 'instrument',
    tags = v_tags,
    outcome = v_outcome,
    summary = v_summary,
    conditions = v_conditions,
    note_kind = v_note_kind,
    alternatives = '{}',
    unclear = '{}',
    follow_up = v_follow_up,
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

create or replace function label_json(p_lab_id uuid, p_sha256 text) returns jsonb
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
    'confidence', l.confidence,
    'outcome', l.outcome,
    'summary', l.summary,
    'conditions', l.conditions,
    'note_kind', l.note_kind,
    'alternatives', to_jsonb(l.alternatives),
    'unclear', to_jsonb(l.unclear),
    'follow_up', l.follow_up,
    'note', note_json(p_lab_id, p_sha256)
  )
  from labels l
  left join experiments e on e.id = l.experiment_id
  left join people p on p.id = l.person_id
  where l.lab_id = p_lab_id and l.sha256 = p_sha256
$$;

-- correct_label gains p_more: any of outcome, summary, conditions and note_kind to set; the
-- ones it leaves out stay as they are. Its first eight arguments are 0004's, so callers that
-- pass them by position (approve_label_suggestion) are unchanged.
drop function correct_label(uuid, text, text, date, uuid, uuid, text, text[]);
create function correct_label(
  p_lab_id uuid,
  p_sha256 text,
  p_clean_name text,
  p_date date,
  p_experiment_id uuid,
  p_person_id uuid,
  p_instrument text,
  p_tags text[],
  p_more jsonb default '{}'
)
returns table (correction_id bigint, label jsonb)
language plpgsql security invoker set search_path = public as $$
declare
  v_id bigint;
  v_more jsonb := coalesce(p_more, '{}');
begin
  if jsonb_typeof(v_more) <> 'object' or exists (
    select 1 from jsonb_object_keys(v_more) k where k not in ('outcome', 'summary', 'conditions', 'note_kind')
  ) then
    raise exception 'p_more takes outcome, summary, conditions and note_kind' using errcode = '22023';
  end if;
  insert into corrections (lab_id, sha256, after)
  values (p_lab_id, p_sha256, v_more || jsonb_build_object(
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

-- Files photographed or picked together. Records the batch on the caller's own upload,
-- once; a retried upload keeps its first batch.
create function tag_upload_batch(p_location_id uuid, p_batch_id uuid) returns void
language sql security definer set search_path = public as $$
  update uploads set batch_id = p_batch_id
  where location_id = p_location_id and uploaded_by = auth.uid() and batch_id is null
    and is_lab_member(lab_id)
$$;

-- Joining files as one note, in the order given, under the caller. When some are already
-- pages of a live note, the rest join that note after its last page. Errors: BL701 fewer
-- than two files, BL702 a file this lab doesn't hold, BL703 pages of two different notes.
create function join_note(p_lab_id uuid, p_shas text[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_note uuid;
  v_notes uuid[];
  v_next int;
  v_sha text;
begin
  if v_user is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  if coalesce(cardinality(array(select distinct s from unnest(p_shas) s)), 0) < 2 then
    raise exception 'a note joins two or more files' using errcode = 'BL701';
  end if;
  if exists (
    select 1 from unnest(p_shas) s
    where not exists (select 1 from file_locations fl where fl.lab_id = p_lab_id and fl.sha256 = s and fl.deleted_at is null)
  ) then
    raise exception 'pick files from this lab' using errcode = 'BL702';
  end if;
  v_notes := array(
    select distinct np.note_id from note_pages np where np.lab_id = p_lab_id and np.live and np.sha256 = any (p_shas)
  );
  if cardinality(v_notes) > 1 then
    raise exception 'those files are pages of different notes' using errcode = 'BL703';
  end if;
  if cardinality(v_notes) = 1 then
    v_note := v_notes[1];
    update notes set state = 'confirmed', updated_at = now() where id = v_note;
  else
    insert into notes (lab_id, state, reason, origin, created_by)
    values (p_lab_id, 'confirmed', 'Joined by a lab member', 'join:' || gen_random_uuid(), v_user)
    returning id into v_note;
  end if;
  select coalesce(max(position), 0) into v_next from note_pages where note_id = v_note and live;
  for v_sha in select s from unnest(p_shas) with ordinality as t (s, ord) group by s order by min(ord) loop
    if not exists (select 1 from note_pages where note_id = v_note and sha256 = v_sha and live) then
      v_next := v_next + 1;
      insert into note_pages as np (note_id, lab_id, sha256, position)
      values (v_note, p_lab_id, v_sha, v_next)
      on conflict (note_id, sha256) do update set live = true, position = excluded.position;
    end if;
  end loop;
  insert into audit_log (lab_id, actor, action, target) values (p_lab_id, v_user, 'note.join', v_note::text);
  return v_note;
end
$$;

-- Splitting a note back into its files. Its pages stay recorded, not live, so the split can
-- be undone with restore_note, and Binary never suggests the same group again.
create function split_note(p_note_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_lab uuid;
begin
  select lab_id into v_lab from notes where id = p_note_id and state <> 'split';
  if v_lab is null or v_user is null or not is_lab_member(v_lab) then
    raise exception 'no such note' using errcode = 'BL704';
  end if;
  update note_pages set live = false where note_id = p_note_id;
  update notes set state = 'split', updated_at = now() where id = p_note_id;
  insert into audit_log (lab_id, actor, action, target) values (v_lab, v_user, 'note.split', p_note_id::text);
end
$$;

-- Undoing a split: the pages come back as one note, unless one has joined another since.
-- BL705 is a page that's now in another note.
create function restore_note(p_note_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_lab uuid;
begin
  select lab_id into v_lab from notes where id = p_note_id and state = 'split';
  if v_lab is null or v_user is null or not is_lab_member(v_lab) then
    raise exception 'no such note' using errcode = 'BL704';
  end if;
  if exists (
    select 1 from note_pages me join note_pages other
      on other.lab_id = me.lab_id and other.sha256 = me.sha256 and other.live and other.note_id <> me.note_id
    where me.note_id = p_note_id
  ) then
    raise exception 'a page is in another note now' using errcode = 'BL705';
  end if;
  update note_pages set live = true where note_id = p_note_id;
  update notes set state = 'confirmed', updated_at = now() where id = p_note_id;
  insert into audit_log (lab_id, actor, action, target) values (v_lab, v_user, 'note.join', p_note_id::text);
end
$$;

-- Keeping a note Binary suggested, so it reads as the lab's own.
create function keep_note(p_note_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_lab uuid;
begin
  select lab_id into v_lab from notes where id = p_note_id and state <> 'split';
  if v_lab is null or v_user is null or not is_lab_member(v_lab) then
    raise exception 'no such note' using errcode = 'BL704';
  end if;
  update notes set state = 'confirmed', updated_at = now() where id = p_note_id and state = 'suggested';
  insert into audit_log (lab_id, actor, action, target) values (v_lab, v_user, 'note.keep', p_note_id::text);
end
$$;

-- Taking one page out of a note; the pages after it move up. A note left with one page is
-- split. BL706 is a file that isn't a page of this note.
create function remove_note_page(p_note_id uuid, p_sha256 text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_lab uuid;
  v_position int;
begin
  select lab_id into v_lab from notes where id = p_note_id and state <> 'split';
  if v_lab is null or v_user is null or not is_lab_member(v_lab) then
    raise exception 'no such note' using errcode = 'BL704';
  end if;
  delete from note_pages where note_id = p_note_id and sha256 = p_sha256 and live
  returning position into v_position;
  if v_position is null then
    raise exception 'that file is not a page of this note' using errcode = 'BL706';
  end if;
  update note_pages set position = position - 1 where note_id = p_note_id and live and position > v_position;
  update notes set state = 'confirmed', updated_at = now() where id = p_note_id;
  if (select count(*) from note_pages where note_id = p_note_id and live) < 2 then
    update note_pages set live = false where note_id = p_note_id;
    update notes set state = 'split' where id = p_note_id;
  end if;
  insert into audit_log (lab_id, actor, action, target) values (v_lab, v_user, 'note.remove_page', p_note_id::text);
end
$$;

-- search_files gains matched_page, so its return type changes and it has to be dropped
-- first. The body is 0012's, then the pages of a live note fold into one row: its first
-- page, which carries the note's label, scored by its best page, with that page's matching
-- text and position, so a word from page 7 finds the note and opens it there.
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

alter function search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int)
  set client_min_messages = warning;

revoke all on notes, note_pages from anon, authenticated;
revoke all on function
  label_conditions_ok(jsonb), label_follow_up_ok(jsonb), label_texts_ok(text[], int, int),
  label_extra_words(label_outcome, note_kind, text, jsonb), note_json(uuid, text),
  correct_label(uuid, text, text, date, uuid, uuid, text, text[], jsonb),
  tag_upload_batch(uuid, uuid), join_note(uuid, text[]), split_note(uuid), restore_note(uuid),
  keep_note(uuid), remove_note_page(uuid, text),
  search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int)
from public, anon, authenticated;

grant select (
  lab_id, sha256, status, clean_name, date, experiment_id, person_id, instrument, tags,
  confidence, source, updated_at, tsv, outcome, summary, conditions, note_kind, alternatives,
  unclear, follow_up, prompt_version
) on labels to authenticated;
grant select on notes, note_pages to authenticated;
grant execute on function
  label_conditions_ok(jsonb), label_follow_up_ok(jsonb), label_texts_ok(text[], int, int),
  label_extra_words(label_outcome, note_kind, text, jsonb), note_json(uuid, text),
  correct_label(uuid, text, text, date, uuid, uuid, text, text[], jsonb),
  tag_upload_batch(uuid, uuid), join_note(uuid, text[]), split_note(uuid), restore_note(uuid),
  keep_note(uuid), remove_note_page(uuid, text),
  search_files(uuid, text, vector, file_kind[], text, timestamptz, timestamptz, int)
to authenticated;
