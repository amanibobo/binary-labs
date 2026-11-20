-- The run record (decisions.md, "the run record: foundation"). A run is one attempt at an
-- experiment: its own row, with files as its evidence. This migration holds every table and
-- column the run record's later slices write (failure fields, planned versus actual, sharing,
-- the spoken debrief, export), so those slices add functions and screens, not columns.
--
-- People make runs. Nothing here creates a run from a label, a sweep or a file version, and
-- nothing here reads or writes labels.outcome: runs.status is the only truth about a run.

-- A new enum value can't be used in the transaction that adds it; only plpgsql bodies written
-- by later migrations name these.
alter type audit_action add value if not exists 'run.export';
alter type audit_action add value if not exists 'run.export_blocked';

create type run_status as enum ('worked', 'failed', 'odd');
create type confirm_method as enum ('control', 'repeat', 'pi_opinion');
create type run_file_role as enum ('evidence', 'shared_control', 'standard');
create type run_fix as enum ('yes', 'no', 'not_sure');
create type run_log_via as enum ('person', 'worker', 'trigger', 'migration');
create type debrief_state as enum ('open', 'approved', 'discarded');

-- The lab's side of sharing: off until an admin agrees, and the wording they agreed to.
alter table labs add column sharing_agreed_at timestamptz;
alter table labs add column sharing_agreed_by uuid references auth.users (id) on delete set null;
alter table labs add column sharing_agreement text;
alter table labs add constraint labs_sharing_agreement_check
  check ((sharing_agreed_at is null) = (sharing_agreement is null));

-- So a run can name a protocol version by a key that carries the lab.
alter table protocol_versions add constraint protocol_versions_id_lab_key unique (id, lab_id);

-- The failure list every lab codes against, so records from different labs line up. Global,
-- written only by migrations. A code never changes meaning; a new version is new rows.
create table failure_taxonomies (
  version smallint primary key check (version > 0),
  -- Null while the list is a draft no working scientist has signed off.
  signed_off_at timestamptz,
  signed_off_by text
);

create table failure_terms (
  version smallint not null references failure_taxonomies (version),
  code text not null check (code ~ '^(tech|step|cause)\.[a-z_]+$'),
  label text not null,
  hint text,
  position smallint not null,
  primary key (version, code)
);

insert into failure_taxonomies (version) values (1);
insert into failure_terms (version, code, label, hint, position) values
  (1, 'tech.pcr', 'PCR', null, 1),
  (1, 'tech.qpcr', 'qPCR or RT-qPCR', null, 2),
  (1, 'tech.cloning', 'Cloning or assembly', null, 3),
  (1, 'tech.transformation', 'Transformation', null, 4),
  (1, 'tech.nucleic_prep', 'DNA or RNA prep', null, 5),
  (1, 'tech.dna_gel', 'DNA or RNA gel', null, 6),
  (1, 'tech.sequencing', 'Sequencing', null, 7),
  (1, 'tech.protein_prep', 'Protein expression or purification', null, 8),
  (1, 'tech.protein_gel', 'Protein gel (SDS-PAGE)', null, 9),
  (1, 'tech.western', 'Western blot', null, 10),
  (1, 'tech.protein_assay', 'Protein amount assay (Bradford, BCA)', null, 11),
  (1, 'tech.elisa', 'ELISA', null, 12),
  (1, 'tech.enzyme_assay', 'Enzyme or activity assay', null, 13),
  (1, 'tech.cell_culture', 'Cell culture', null, 14),
  (1, 'tech.transfection', 'Transfection or transduction', null, 15),
  (1, 'tech.viability', 'Cell viability or dose-response', null, 16),
  (1, 'tech.flow', 'Flow cytometry', null, 17),
  (1, 'tech.microscopy', 'Microscopy or imaging', null, 18),
  (1, 'tech.staining', 'Immunostaining', null, 19),
  (1, 'tech.microbial_growth', 'Bacterial or yeast growth', null, 20),
  (1, 'tech.other', 'Something else', null, 21),
  (1, 'step.planning', 'Planning', 'The design, the controls chosen, the maths', 1),
  (1, 'step.reagent_prep', 'Making reagents', 'Buffers, media, dilutions, stocks', 2),
  (1, 'step.sample_prep', 'Preparing samples', 'Extraction, lysis, counting cells', 3),
  (1, 'step.setup', 'Setting up', 'Pipetting, loading, plating', 4),
  (1, 'step.run', 'The run itself', 'Incubation, cycling, time on the machine', 5),
  (1, 'step.handling', 'Between steps', 'Washes, transfers, waiting', 6),
  (1, 'step.measurement', 'Measuring', 'The read, the image, the scan', 7),
  (1, 'step.analysis', 'Analysing the data', 'Formulas, software, gating', 8),
  (1, 'step.storage', 'Storage', 'Before or after the run', 9),
  (1, 'step.unknown', 'Not known yet', null, 10),
  (1, 'cause.reagent', 'A reagent was bad', 'Expired, degraded, wrong lot', 1),
  (1, 'cause.amount', 'Wrong amount or concentration', 'A slip in pipetting or a calculation', 2),
  (1, 'cause.sample', 'The sample was the problem', 'Degraded, too little, poor quality', 3),
  (1, 'cause.mix_up', 'Labels or tubes mixed up', null, 4),
  (1, 'cause.contamination', 'Contamination', null, 5),
  (1, 'cause.equipment', 'An instrument or tool', 'Fault, calibration, wrong setting', 6),
  (1, 'cause.conditions', 'Time or temperature was off', null, 7),
  (1, 'cause.step_missed', 'A step was missed or changed', null, 8),
  (1, 'cause.protocol', 'The protocol doesn''t work for this', 'It was followed and still failed', 9),
  (1, 'cause.analysis', 'A mistake in the analysis', null, 10),
  (1, 'cause.biology', 'A real result, not a mistake', 'The biology did something unexpected', 11),
  (1, 'cause.unknown', 'Not known', null, 12),
  (1, 'cause.other', 'Something else', null, 13);

create table runs (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  started_on date,
  ended_on date,
  experiment_id uuid,
  -- Who ran it: a person of the lab, who may have no account.
  person_id uuid,
  -- The earlier run this one retries.
  retry_of uuid,

  -- How the attempt went. Null: nobody has said.
  status run_status,
  -- Null with a status set: seeded from what the first file's label said when the run was made.
  status_by uuid references auth.users (id) on delete set null,
  status_at timestamptz,

  -- The failure record.
  suspected_cause text check (suspected_cause is null or length(btrim(suspected_cause)) between 1 and 4000),
  suspected_by uuid references auth.users (id) on delete set null,
  confirmed_cause text check (confirmed_cause is null or length(btrim(confirmed_cause)) between 1 and 4000),
  -- The named confirmer, and who typed it in.
  confirmed_by uuid,
  confirm_method confirm_method,
  confirm_note text check (confirm_note is null or length(confirm_note) <= 2000),
  -- The repeat that showed it, or the control file (one of this run's files) that did.
  confirm_run uuid,
  confirm_sha256 text,
  confirmed_at timestamptz,
  confirm_recorded_by uuid references auth.users (id) on delete set null,
  -- Set only when the confirmer's own account says yes.
  confirmer_attested_at timestamptz,
  taxonomy_version smallint,
  technique text check (technique like 'tech.%'),
  failed_step text check (failed_step like 'step.%'),
  cause_category text check (cause_category like 'cause.%'),

  -- The debrief: each is the scientist's own answer to one fixed question, word for word.
  aim text,
  expected_seen text,
  how_found text,
  what_changed text,
  fix_worked run_fix,
  who_else text,
  debriefed_at timestamptz,

  -- Planned versus actual: the protocol as written, and the text as actually run with the
  -- version that text started from.
  planned_version_id uuid,
  as_run_body text check (as_run_body is null or length(as_run_body) <= 200000),
  as_run_based_on uuid,
  as_run_by uuid references auth.users (id) on delete set null,
  as_run_at timestamptz,

  -- The run's side of sharing. Off unless a person turns it on.
  share boolean not null default false,

  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, lab_id),
  foreign key (experiment_id, lab_id) references experiments (id, lab_id) on delete set null (experiment_id),
  foreign key (person_id, lab_id) references people (id, lab_id) on delete set null (person_id),
  foreign key (retry_of, lab_id) references runs (id, lab_id) on delete set null (retry_of),
  -- A named confirmer can't be deleted from under a confirmed cause.
  foreign key (confirmed_by, lab_id) references people (id, lab_id) on delete restrict,
  foreign key (confirm_run, lab_id) references runs (id, lab_id) on delete set null (confirm_run),
  foreign key (planned_version_id, lab_id) references protocol_versions (id, lab_id)
    on delete set null (planned_version_id),
  foreign key (as_run_based_on, lab_id) references protocol_versions (id, lab_id)
    on delete set null (as_run_based_on),
  foreign key (taxonomy_version, technique) references failure_terms (version, code),
  foreign key (taxonomy_version, failed_step) references failure_terms (version, code),
  foreign key (taxonomy_version, cause_category) references failure_terms (version, code),
  check (retry_of is distinct from id),
  check (ended_on is null or (started_on is not null and ended_on >= started_on)),
  check ((status is null) = (status_at is null)),
  -- A confirmed cause always has a named confirmer, a method and a time.
  check ((confirmed_cause is null) = (confirmed_by is null)
    and (confirmed_by is null) = (confirm_method is null)
    and (confirm_method is null) = (confirmed_at is null)),
  -- Causes belong to runs that failed or were odd. Written so a null status can't slip through.
  check (status is not distinct from 'failed' or status is not distinct from 'odd'
    or (suspected_cause is null and confirmed_cause is null)),
  check ((taxonomy_version is null) = (technique is null and failed_step is null and cause_category is null)),
  check ((as_run_body is null) = (as_run_at is null))
);
create index runs_lab_started_idx on runs (lab_id, started_on desc nulls last, created_at desc);
create index runs_retry_idx on runs (retry_of) where retry_of is not null;

-- A run's files. A file can be evidence of several runs (a shared control plate, a standard
-- curve), so nothing here is unique per file. sha256 is the content when it was added: a later
-- edit in Dropbox is a new version with a new sha256, and the run still names this one.
create table run_files (
  run_id uuid not null,
  lab_id uuid not null,
  sha256 text not null references blobs (sha256),
  role run_file_role not null default 'evidence',
  -- The order the files were picked in; the first is the one the run was named from.
  position int not null check (position > 0),
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (run_id, sha256),
  foreign key (run_id, lab_id) references runs (id, lab_id) on delete cascade
);
create index run_files_lab_sha_idx on run_files (lab_id, sha256);

alter table runs add constraint runs_confirm_file_fk
  foreign key (id, confirm_sha256) references run_files (run_id, sha256) on delete set null (confirm_sha256);

-- One append-only log for run edits, both sharing switches and every export attempt. `via`
-- says how the change came about, so a null actor isn't ambiguous.
create table run_log (
  id bigint generated always as identity primary key,
  lab_id uuid not null references labs (id) on delete cascade,
  -- Null for the lab's own rows.
  run_id uuid,
  actor uuid references auth.users (id) on delete set null,
  via run_log_via not null,
  action text not null check (action in (
    'run.create', 'run.edit', 'run.files', 'run.share', 'lab.share', 'export.allowed', 'export.blocked'
  )),
  before jsonb,
  after jsonb,
  at timestamptz not null default now(),
  foreign key (run_id, lab_id) references runs (id, lab_id) on delete cascade
);
create index run_log_run_idx on run_log (run_id, id);
create index run_log_lab_idx on run_log (lab_id, id);

-- The spoken (or typed) debrief of a run that failed or was odd: six fixed questions, one
-- answer each. An answer is a recording, whose transcript is `text`, or typed, where `text`
-- is what was typed. The functions that write answers check the recording is the lab's.
create table run_debriefs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  lab_id uuid not null,
  questions_version smallint not null default 1,
  state debrief_state not null default 'open',
  started_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  unique (id, lab_id),
  foreign key (run_id, lab_id) references runs (id, lab_id) on delete cascade,
  check ((state = 'approved') = (approved_at is not null))
);
create unique index run_debriefs_one_open_idx on run_debriefs (run_id) where state = 'open';

create table run_debrief_answers (
  debrief_id uuid not null,
  lab_id uuid not null,
  question smallint not null check (question between 1 and 6),
  location_id uuid references file_locations (id) on delete set null,
  text text check (text is null or length(text) <= 20000),
  typed boolean not null default false,
  -- Question 5's tap: did the change fix it? Never inferred from the words.
  fix_worked run_fix,
  answered_at timestamptz not null default now(),
  primary key (debrief_id, question),
  foreign key (debrief_id, lab_id) references run_debriefs (id, lab_id) on delete cascade,
  check (fix_worked is null or question = 5),
  check (not typed or location_id is null)
);
create index run_debrief_answers_location_idx on run_debrief_answers (location_id) where location_id is not null;

-- A member who has been shown "Turn these into runs?" and put it away.
create table run_suggestion_dismissals (
  lab_id uuid not null references labs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  primary key (lab_id, user_id)
);

-- Export. What the lab leaves out of anything exported, the question and rubric written for
-- a run, the second scientist's review, the folder built, and each model's attempt at it.
create table export_exclusions (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null references labs (id) on delete cascade,
  kind text not null check (kind in ('field', 'tag', 'experiment', 'folder', 'text')),
  value text not null check (length(btrim(value)) between 1 and 400),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (lab_id, kind, value)
);

create table run_rubrics (
  run_id uuid primary key,
  lab_id uuid not null,
  question text not null check (length(btrim(question)) between 1 and 4000),
  rubric jsonb not null default '[]' check (jsonb_typeof(rubric) = 'array'),
  written_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  foreign key (run_id, lab_id) references runs (id, lab_id) on delete cascade
);

create table run_reviews (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  lab_id uuid not null,
  -- The second scientist, a person of the lab.
  reviewer_id uuid,
  notes text not null check (length(btrim(notes)) between 1 and 8000),
  agrees boolean,
  recorded_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz not null default now(),
  foreign key (run_id, lab_id) references runs (id, lab_id) on delete cascade,
  foreign key (reviewer_id, lab_id) references people (id, lab_id) on delete set null (reviewer_id)
);
create index run_reviews_run_idx on run_reviews (run_id);

create table task_exports (
  id uuid primary key default gen_random_uuid(),
  lab_id uuid not null,
  run_id uuid not null,
  -- The run_log row that allowed it. One grant builds one folder.
  grant_id bigint not null unique references run_log (id) on delete cascade,
  purpose text not null check (length(btrim(purpose)) between 1 and 200),
  taxonomy_version smallint references failure_taxonomies (version),
  -- Where the folder's files sit in our store, and what is in it.
  storage_prefix text,
  manifest jsonb not null default '{}',
  built_by uuid references auth.users (id) on delete set null,
  built_at timestamptz not null default now(),
  -- Set when sharing went off after the folder was built: the folder is to be removed and is
  -- never handed out again.
  withdrawn_at timestamptz,
  unique (id, lab_id),
  foreign key (run_id, lab_id) references runs (id, lab_id) on delete cascade
);
create index task_exports_run_idx on task_exports (run_id);

create table task_model_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  lab_id uuid not null,
  model text not null check (length(btrim(model)) between 1 and 200),
  answer text,
  solved boolean,
  started_at timestamptz not null default now(),
  graded_at timestamptz,
  foreign key (task_id, lab_id) references task_exports (id, lab_id) on delete cascade
);
create index task_model_runs_task_idx on task_model_runs (task_id);

-- Row security: members read their lab's rows and write none of them directly.
alter table failure_taxonomies enable row level security;
alter table failure_terms enable row level security;
alter table runs enable row level security;
alter table run_files enable row level security;
alter table run_log enable row level security;
alter table run_debriefs enable row level security;
alter table run_debrief_answers enable row level security;
alter table run_suggestion_dismissals enable row level security;
alter table export_exclusions enable row level security;
alter table run_rubrics enable row level security;
alter table run_reviews enable row level security;
alter table task_exports enable row level security;
alter table task_model_runs enable row level security;

create policy failure_taxonomies_select on failure_taxonomies for select using (auth.uid() is not null);
create policy failure_terms_select on failure_terms for select using (auth.uid() is not null);
create policy runs_select on runs for select using (is_lab_member(lab_id));
create policy run_files_select on run_files for select using (is_lab_member(lab_id));
create policy run_log_select on run_log for select using (is_lab_member(lab_id));
create policy run_debriefs_select on run_debriefs for select using (is_lab_member(lab_id));
create policy run_debrief_answers_select on run_debrief_answers for select using (is_lab_member(lab_id));
create policy run_suggestion_dismissals_select on run_suggestion_dismissals for select
  using (is_lab_member(lab_id) and user_id = auth.uid());
create policy export_exclusions_select on export_exclusions for select using (is_lab_member(lab_id));
create policy run_rubrics_select on run_rubrics for select using (is_lab_member(lab_id));
create policy run_reviews_select on run_reviews for select using (is_lab_member(lab_id));
create policy task_exports_select on task_exports for select using (is_lab_member(lab_id));
create policy task_model_runs_select on task_model_runs for select using (is_lab_member(lab_id));

-- ---------------------------------------------------------------------------------------
-- Triggers. These cover every writer, the worker included (it connects as the owner and
-- skips row security), so no later slice can forget the log or the consent check.

-- A run's file is content this lab has read, never just any blob.
create function run_files_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from file_versions fv where fv.lab_id = new.lab_id and fv.sha256 = new.sha256) then
    raise exception 'that file isn''t in this lab' using errcode = 'BL901';
  end if;
  return new;
end
$$;
create trigger run_files_check before insert on run_files
for each row execute function run_files_check();

-- How a change came about: a function may say (binary.run_via), else a signed-in caller is a
-- person and anything else is the worker.
create function run_via() returns run_log_via
language sql stable set search_path = public as $$
  select coalesce(
    nullif(current_setting('binary.run_via', true), '')::run_log_via,
    case when auth.uid() is null then 'worker' else 'person' end::run_log_via
  )
$$;

-- Any change to a shared run turns its sharing off: what was agreed to share is what the run
-- said then. Turning it on again is a person's choice.
create function runs_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.lab_id <> old.lab_id then
    raise exception 'a run stays in its lab' using errcode = '42501';
  end if;
  new.updated_at := now();
  if old.share and new.share
    and (to_jsonb(new) - 'share' - 'updated_at') is distinct from (to_jsonb(old) - 'share' - 'updated_at') then
    new.share := false;
  end if;
  return new;
end
$$;
create trigger runs_before_update before update on runs
for each row execute function runs_before_update();

-- Every insert and change of a run, with the changed columns' before and after. Sharing gets
-- its own row; one that went off because the run changed is marked as the trigger's doing.
-- Sharing going off also withdraws the folders already built from the run.
create function runs_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  if tg_op = 'INSERT' then
    insert into run_log (lab_id, run_id, actor, via, action, after)
    values (new.lab_id, new.id, auth.uid(), run_via(), 'run.create', jsonb_strip_nulls(to_jsonb(new) - 'updated_at'));
    return null;
  end if;
  v_old := to_jsonb(old) - 'updated_at';
  v_new := to_jsonb(new) - 'updated_at';
  select jsonb_object_agg(n.key, v_old -> n.key), jsonb_object_agg(n.key, n.value) into v_before, v_after
  from jsonb_each(v_new) n where n.value is distinct from v_old -> n.key;
  if v_after is null then
    return null;
  end if;
  if v_after - 'share' <> '{}' then
    insert into run_log (lab_id, run_id, actor, via, action, before, after)
    values (new.lab_id, new.id, auth.uid(), run_via(), 'run.edit', v_before - 'share', v_after - 'share');
  end if;
  if v_after ? 'share' then
    insert into run_log (lab_id, run_id, actor, via, action, before, after)
    values (
      new.lab_id, new.id, auth.uid(),
      case when not new.share and v_after - 'share' <> '{}' then 'trigger' else run_via() end,
      'run.share', jsonb_build_object('share', old.share), jsonb_build_object('share', new.share)
    );
    if not new.share then
      update task_exports set withdrawn_at = now() where run_id = new.id and withdrawn_at is null;
    end if;
  end if;
  return null;
end
$$;
create trigger runs_log after insert or update on runs
for each row execute function runs_log();

-- A file added, removed or given another role: logged, and a shared run stops being shared.
create function run_files_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row run_files := coalesce(new, old);
  v_via text := current_setting('binary.run_via', true);
begin
  if tg_op = 'UPDATE' and new.role = old.role then
    return null;
  end if;
  -- The run itself is going (its lab is being deleted): nothing to log against.
  if not exists (select 1 from runs where id = v_row.run_id) then
    return null;
  end if;
  insert into run_log (lab_id, run_id, actor, via, action, before, after)
  values (
    v_row.lab_id, v_row.run_id, auth.uid(), run_via(), 'run.files',
    case when tg_op <> 'INSERT' then jsonb_build_object('sha256', old.sha256, 'role', old.role) end,
    case when tg_op <> 'DELETE' then jsonb_build_object('sha256', new.sha256, 'role', new.role) end
  );
  perform set_config('binary.run_via', 'trigger', true);
  update runs set share = false where id = v_row.run_id and share;
  perform set_config('binary.run_via', coalesce(v_via, ''), true);
  return null;
end
$$;
create trigger run_files_log after insert or update or delete on run_files
for each row execute function run_files_log();

-- The lab's agreement changing is logged, and an agreement withdrawn (or a lab turned into a
-- demo lab) withdraws every folder built from the lab's runs.
create function labs_sharing_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.sharing_agreed_at is distinct from old.sharing_agreed_at
    or new.sharing_agreement is distinct from old.sharing_agreement then
    insert into run_log (lab_id, actor, via, action, before, after)
    values (
      new.id, auth.uid(), run_via(), 'lab.share',
      jsonb_build_object('agreed_at', old.sharing_agreed_at, 'agreement', old.sharing_agreement),
      jsonb_build_object('agreed_at', new.sharing_agreed_at, 'agreement', new.sharing_agreement)
    );
  end if;
  if new.sharing_agreed_at is null or new.plan = 'demo' then
    update task_exports set withdrawn_at = now() where lab_id = new.id and withdrawn_at is null;
  end if;
  return null;
end
$$;
create trigger labs_sharing_log after update of sharing_agreed_at, sharing_agreement, plan on labs
for each row execute function labs_sharing_log();

-- Why a run can't leave the lab right now; empty when it can, null when there is no such run.
-- The one place the rule is written: the run's switch, the lab's agreement, and never a demo
-- lab (its data is made up).
create function run_export_blocks(p_run_id uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select array_remove(array[
    case when not r.share then 'run_off' end,
    case when l.sharing_agreed_at is null then 'lab_off' end,
    case when l.plan = 'demo' then 'demo_lab' end
  ], null)
  from runs r join labs l on l.id = r.lab_id
  where r.id = p_run_id
$$;

-- A folder can only be built while both switches are on, from a grant made for this run in the
-- last hour and not used before (grant_id is unique). BL951: sharing is off. BL952: no grant.
create function task_exports_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_blocks text[];
  g run_log;
begin
  if tg_op = 'UPDATE' then
    if new.run_id <> old.run_id or new.lab_id <> old.lab_id or new.grant_id <> old.grant_id
      or (old.withdrawn_at is not null and new.withdrawn_at is null) then
      raise exception 'an export keeps its run and its grant, and stays withdrawn' using errcode = 'BL952';
    end if;
    return new;
  end if;
  v_blocks := run_export_blocks(new.run_id);
  if v_blocks is null or cardinality(v_blocks) > 0 then
    raise exception 'this run isn''t shared: %', coalesce(array_to_string(v_blocks, ', '), 'no such run')
      using errcode = 'BL951';
  end if;
  select * into g from run_log where id = new.grant_id;
  if not found or g.action <> 'export.allowed' or g.run_id is distinct from new.run_id
    or g.lab_id <> new.lab_id or g.at < now() - interval '1 hour' then
    raise exception 'no fresh grant for this run' using errcode = 'BL952';
  end if;
  return new;
end
$$;
create trigger task_exports_check before insert or update on task_exports
for each row execute function task_exports_check();

-- The worker calls this before anything about a task leaves for a model. BL951 unless the
-- folder still stands and its run can still be shared.
create function assert_exportable(p_task_id uuid) returns void
language plpgsql stable security definer set search_path = public as $$
declare
  t task_exports;
  v_blocks text[];
begin
  select * into t from task_exports where id = p_task_id;
  if not found or t.withdrawn_at is not null then
    raise exception 'this export was withdrawn' using errcode = 'BL951';
  end if;
  v_blocks := run_export_blocks(t.run_id);
  if v_blocks is null or cardinality(v_blocks) > 0 then
    raise exception 'this run isn''t shared: %', coalesce(array_to_string(v_blocks, ', '), 'no such run')
      using errcode = 'BL951';
  end if;
end
$$;

create function task_model_runs_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform assert_exportable(new.task_id);
  return new;
end
$$;
create trigger task_model_runs_check before insert on task_model_runs
for each row execute function task_model_runs_check();

-- ---------------------------------------------------------------------------------------
-- Functions. Each one that takes a run reads the lab from the run's row and checks the caller
-- is a member of it.

-- The run, locked for a change. BL907: no such run. 42501: not the caller's lab. Every
-- function that changes a run starts here, the later slices' too.
create function member_run(p_run_id uuid) returns runs
language plpgsql security definer set search_path = public as $$
declare
  r runs;
begin
  if auth.uid() is null then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  select * into r from runs where id = p_run_id for update;
  if not found then
    raise exception 'no such run' using errcode = 'BL907';
  end if;
  if not is_lab_member(r.lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  return r;
end
$$;

-- A recording made to explain a procedure or to debrief a run is not a run's evidence.
create function is_recording(p_lab_id uuid, p_sha256 text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_lab_member(p_lab_id) and exists (
    select 1 from file_locations fl
    where fl.lab_id = p_lab_id and fl.sha256 = p_sha256 and (
      exists (select 1 from talk_throughs t where t.location_id = fl.id)
      or exists (select 1 from run_debrief_answers a where a.location_id = fl.id)
    )
  )
$$;

-- A run as another points at it.
create function run_ref_json(p_run_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object('id', r.id, 'title', r.title, 'started_on', r.started_on, 'status', r.status)
  from runs r where r.id = p_run_id
$$;

-- One run, whole, for a member of its lab; null for anyone else. A file's name is its label's
-- title, else the name it had when Binary read it. `location_id` is where it lives in the lab
-- now (null once it's gone from the lab's folder); `kept` says its own bytes are in our store.
-- `file_says` is what the file's label reads as the outcome: a hint, never the run's status.
-- `retry_hint` is a run this one might be a retry of, from a repeat link between their files.
create function run_json(p_run_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', r.id,
    'title', r.title,
    'started_on', r.started_on,
    'ended_on', r.ended_on,
    'experiment', case when e.id is null then null else jsonb_build_object('id', e.id, 'name', e.name) end,
    'person', case when p.id is null then null else jsonb_build_object('id', p.id, 'name', p.display_name) end,
    'status', r.status,
    'status_by', r.status_by,
    'status_at', r.status_at,
    'created_by', r.created_by,
    'created_at', r.created_at,
    'updated_at', r.updated_at,
    'retry_of', run_ref_json(r.retry_of),
    'retried_in', coalesce((
      select jsonb_agg(run_ref_json(n.id) order by n.started_on nulls last, n.created_at)
      from runs n where n.retry_of = r.id
    ), '[]'),
    'retry_hint', case when r.retry_of is null then (
      select run_ref_json(o.run_id)
      from run_files f
      join run_repeats rr on rr.lab_id = f.lab_id and rr.sha256 = f.sha256
      join run_files o on o.lab_id = f.lab_id and o.sha256 = rr.repeats and o.role = 'evidence' and o.run_id <> r.id
      join runs older on older.id = o.run_id
      where f.run_id = r.id and f.role = 'evidence'
      order by older.created_at desc
      limit 1
    ) end,
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sha256', f.sha256,
        'role', f.role,
        'name', coalesce(case when l.status <> 'needs_look' then l.clean_name end, v.original_name, f.sha256),
        'original_name', v.original_name,
        'file_kind', b.file_kind,
        'size', b.size,
        -- The place that holds this content now, or else the live place whose history
        -- holds it: a file edited in the lab's folder after the run is still there.
        'location_id', coalesce((
          select fl.id from file_locations fl
          where fl.lab_id = f.lab_id and fl.sha256 = f.sha256 and fl.deleted_at is null
          order by fl.modified_at desc, fl.id limit 1
        ), (
          select fl.id from file_versions fv join file_locations fl on fl.id = fv.location_id
          where fv.lab_id = f.lab_id and fv.sha256 = f.sha256 and fl.deleted_at is null
          order by fv.seen_at desc, fv.id limit 1
        )),
        'kept', coalesce(v.kept, false),
        'file_says', l.outcome
      ) order by f.position, f.added_at, f.sha256)
      from run_files f
      join blobs b on b.sha256 = f.sha256
      left join labels l on l.lab_id = f.lab_id and l.sha256 = f.sha256
      left join lateral (
        select (array_agg(fv.original_name order by fv.seen_at desc, fv.id))[1] as original_name,
          bool_or(fv.kept_at is not null) as kept
        from file_versions fv where fv.lab_id = f.lab_id and fv.sha256 = f.sha256
      ) v on true
      where f.run_id = r.id
    ), '[]'),
    'failure', jsonb_build_object(
      'suspected_cause', r.suspected_cause,
      'suspected_by', r.suspected_by,
      'confirmed_cause', r.confirmed_cause,
      'confirmed_by', case when c.id is null then null else jsonb_build_object('id', c.id, 'name', c.display_name) end,
      'confirm_method', r.confirm_method,
      'confirm_note', r.confirm_note,
      'confirm_run', run_ref_json(r.confirm_run),
      'confirm_sha256', r.confirm_sha256,
      'confirmed_at', r.confirmed_at,
      'confirm_recorded_by', r.confirm_recorded_by,
      'confirmer_attested_at', r.confirmer_attested_at,
      'taxonomy_version', r.taxonomy_version,
      'technique', r.technique,
      'failed_step', r.failed_step,
      'cause_category', r.cause_category
    ),
    'debrief', jsonb_build_object(
      'aim', r.aim,
      'expected_seen', r.expected_seen,
      'how_found', r.how_found,
      'what_changed', r.what_changed,
      'fix_worked', r.fix_worked,
      'who_else', r.who_else,
      'debriefed_at', r.debriefed_at
    ),
    'plan', jsonb_build_object(
      'planned', case when pv.id is null then null else jsonb_build_object(
        'version_id', pv.id, 'protocol_id', pv.protocol_id, 'title', pv.title, 'version', pv.version
      ) end,
      'as_run', case when r.as_run_body is null then null else jsonb_build_object(
        'body', r.as_run_body, 'based_on', r.as_run_based_on, 'by', r.as_run_by, 'at', r.as_run_at
      ) end
    ),
    'share', r.share
  )
  from runs r
  left join experiments e on e.id = r.experiment_id
  left join people p on p.id = r.person_id
  left join people c on c.id = r.confirmed_by
  left join protocol_versions pv on pv.id = r.planned_version_id
  where r.id = p_run_id and is_lab_member(r.lab_id)
$$;

-- Adds files to a run in the order given, after the ones it has. A file already in the run
-- takes the role given. Not callable by members directly: create_run and add_run_files check
-- the caller first. BL901: a file with no place in this lab. BL904: a recording.
create function put_run_files(p_run_id uuid, p_lab_id uuid, p_shas text[], p_role run_file_role) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_sha text;
  v_next int;
begin
  select coalesce(max(position), 0) into v_next from run_files where run_id = p_run_id;
  for v_sha in select s from unnest(p_shas) with ordinality as t (s, ord) group by s order by min(ord) loop
    if exists (select 1 from run_files where run_id = p_run_id and sha256 = v_sha) then
      update run_files set role = p_role where run_id = p_run_id and sha256 = v_sha;
      continue;
    end if;
    if not exists (
      select 1 from file_locations fl
      where fl.lab_id = p_lab_id and fl.sha256 = v_sha and fl.deleted_at is null
    ) then
      raise exception 'that file isn''t in this lab' using errcode = 'BL901';
    end if;
    if is_recording(p_lab_id, v_sha) then
      raise exception 'a recording can''t be a run''s file' using errcode = 'BL904';
    end if;
    v_next := v_next + 1;
    insert into run_files (run_id, lab_id, sha256, role, position, added_by)
    values (p_run_id, p_lab_id, v_sha, p_role, v_next, auth.uid());
  end loop;
end
$$;

-- Makes a run from the files a person picked (1 to 50). p_fields may hold title, started_on,
-- ended_on, experiment_id, person_id, status and retry_of. What it leaves out is read once
-- from the first file's label: its name, its day, its experiment and person, and its outcome
-- as the run's first status (worked or failed only). After that the label and the run go
-- their own ways. With no person on the label, the caller's own person is used.
-- Errors: BL901 a file not in this lab, BL904 a recording, BL905 an experiment or person not
-- in this lab, BL907 no such run to retry, BL908 no files, too many, or no name to give it.
create function create_run(p_lab_id uuid, p_shas text[], p_fields jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_fields jsonb := coalesce(p_fields, '{}');
  v_first text := p_shas[1];
  l labels;
  v_title text;
  v_experiment uuid;
  v_person uuid;
  v_status run_status;
  v_seeded boolean := false;
  v_retry uuid := nullif(v_fields ->> 'retry_of', '')::uuid;
  v_run uuid;
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_shas), 0) not between 1 and 50 then
    raise exception 'pick 1 to 50 files' using errcode = 'BL908';
  end if;
  select * into l from labels where lab_id = p_lab_id and sha256 = v_first and status <> 'needs_look';
  v_title := left(btrim(coalesce(
    nullif(btrim(v_fields ->> 'title'), ''),
    l.clean_name,
    (select fl.original_name from file_locations fl
     where fl.lab_id = p_lab_id and fl.sha256 = v_first and fl.deleted_at is null
     order by fl.modified_at desc limit 1)
  )), 200);
  if v_title is null or v_title = '' then
    raise exception 'that file isn''t in this lab' using errcode = 'BL901';
  end if;
  v_experiment := case when v_fields ? 'experiment_id' then nullif(v_fields ->> 'experiment_id', '')::uuid else l.experiment_id end;
  v_person := case when v_fields ? 'person_id' then nullif(v_fields ->> 'person_id', '')::uuid
    else coalesce(l.person_id, (select id from people where lab_id = p_lab_id and member_user_id = auth.uid() limit 1)) end;
  if (v_experiment is not null and not exists (select 1 from experiments where id = v_experiment and lab_id = p_lab_id))
    or (v_person is not null and not exists (select 1 from people where id = v_person and lab_id = p_lab_id)) then
    raise exception 'no such experiment or person in this lab' using errcode = 'BL905';
  end if;
  if v_retry is not null and not exists (select 1 from runs where id = v_retry and lab_id = p_lab_id) then
    raise exception 'no such run' using errcode = 'BL907';
  end if;
  if v_fields ? 'status' then
    v_status := nullif(v_fields ->> 'status', '')::run_status;
  elsif l.outcome in ('worked', 'failed') then
    v_status := l.outcome::text::run_status;
    v_seeded := true;
  end if;

  insert into runs (lab_id, title, started_on, ended_on, experiment_id, person_id, retry_of,
    status, status_by, status_at, created_by)
  values (
    p_lab_id, v_title,
    case when v_fields ? 'started_on' then nullif(v_fields ->> 'started_on', '')::date else l.date end,
    nullif(v_fields ->> 'ended_on', '')::date,
    v_experiment, v_person, v_retry,
    v_status, case when v_status is not null and not v_seeded then auth.uid() end,
    case when v_status is not null then now() end,
    auth.uid()
  )
  returning id into v_run;
  perform put_run_files(v_run, p_lab_id, p_shas, 'evidence');
  return run_json(v_run);
end
$$;

-- Adds files to a run, or changes the role of ones it has. BL901, BL904 as create_run; BL908
-- none or more than 50.
create function add_run_files(p_run_id uuid, p_shas text[], p_role run_file_role default 'evidence') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
begin
  if coalesce(cardinality(p_shas), 0) not between 1 and 50 then
    raise exception 'pick 1 to 50 files' using errcode = 'BL908';
  end if;
  perform put_run_files(r.id, r.lab_id, p_shas, coalesce(p_role, 'evidence'));
  return run_json(r.id);
end
$$;

-- Takes a file out of a run. The file itself is untouched. BL902: a run keeps one file.
create function remove_run_file(p_run_id uuid, p_sha256 text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
begin
  if not exists (select 1 from run_files where run_id = r.id and sha256 <> p_sha256) then
    raise exception 'a run keeps at least one file' using errcode = 'BL902';
  end if;
  delete from run_files where run_id = r.id and sha256 = p_sha256;
  return run_json(r.id);
end
$$;

-- Says how a run went: worked, failed, odd, or null to take the answer back. A run with a
-- cause written down only leaves failed and odd when the caller says to clear the causes
-- (p_clear_causes), which removes the suspected and confirmed cause and the failure type; the
-- log keeps what they were. BL906: it has causes and the caller didn't say to clear them.
create function set_run_status(p_run_id uuid, p_status run_status, p_clear_causes boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
  v_keeps boolean := p_status is not distinct from 'failed' or p_status is not distinct from 'odd';
begin
  if r.status is not distinct from p_status then
    return run_json(r.id);
  end if;
  if not v_keeps and (r.suspected_cause is not null or r.confirmed_cause is not null) and not coalesce(p_clear_causes, false) then
    raise exception 'this run has a cause written down' using errcode = 'BL906';
  end if;
  if v_keeps then
    update runs set status = p_status, status_by = auth.uid(), status_at = now() where id = r.id;
  else
    update runs set
      status = p_status, status_by = auth.uid(), status_at = case when p_status is not null then now() end,
      suspected_cause = null, suspected_by = null,
      confirmed_cause = null, confirmed_by = null, confirm_method = null, confirm_note = null,
      confirm_run = null, confirm_sha256 = null, confirmed_at = null, confirm_recorded_by = null,
      confirmer_attested_at = null,
      taxonomy_version = null, technique = null, failed_step = null, cause_category = null
    where id = r.id;
  end if;
  return run_json(r.id);
end
$$;

-- Changes what a run is called, when it ran, its experiment and who ran it. p_fields holds
-- only the keys to change: title, started_on, ended_on, experiment_id, person_id.
-- BL905: an experiment or person not in this lab. BL908: an empty title.
create function edit_run(p_run_id uuid, p_fields jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
  v_fields jsonb := coalesce(p_fields, '{}');
  v_title text := case when v_fields ? 'title' then left(btrim(coalesce(v_fields ->> 'title', '')), 200) else r.title end;
  v_experiment uuid := case when v_fields ? 'experiment_id' then nullif(v_fields ->> 'experiment_id', '')::uuid else r.experiment_id end;
  v_person uuid := case when v_fields ? 'person_id' then nullif(v_fields ->> 'person_id', '')::uuid else r.person_id end;
begin
  if v_title = '' then
    raise exception 'a run needs a name' using errcode = 'BL908';
  end if;
  if (v_experiment is not null and not exists (select 1 from experiments where id = v_experiment and lab_id = r.lab_id))
    or (v_person is not null and not exists (select 1 from people where id = v_person and lab_id = r.lab_id)) then
    raise exception 'no such experiment or person in this lab' using errcode = 'BL905';
  end if;
  update runs set
    title = v_title,
    started_on = case when v_fields ? 'started_on' then nullif(v_fields ->> 'started_on', '')::date else started_on end,
    ended_on = case when v_fields ? 'ended_on' then nullif(v_fields ->> 'ended_on', '')::date else ended_on end,
    experiment_id = v_experiment,
    person_id = v_person
  where id = r.id
    and (title, started_on, ended_on, experiment_id, person_id) is distinct from (
      v_title,
      case when v_fields ? 'started_on' then nullif(v_fields ->> 'started_on', '')::date else started_on end,
      case when v_fields ? 'ended_on' then nullif(v_fields ->> 'ended_on', '')::date else ended_on end,
      v_experiment, v_person
    );
  return run_json(r.id);
end
$$;

-- Says this run retries an earlier one (p_retry_of), or takes the link away (null).
-- BL903: itself, or a run that already retries this one (a loop). BL907: no such run here.
create function link_retry(p_run_id uuid, p_retry_of uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r runs := member_run(p_run_id);
begin
  -- One retry link at a time per lab, so two links made at once can't close a loop.
  perform pg_advisory_xact_lock(hashtextextended('run_retry:' || r.lab_id::text, 0));
  if p_retry_of is null then
    update runs set retry_of = null where id = r.id and retry_of is not null;
    return run_json(r.id);
  end if;
  if not exists (select 1 from runs where id = p_retry_of and lab_id = r.lab_id) then
    raise exception 'no such run' using errcode = 'BL907';
  end if;
  if p_retry_of = r.id or exists (
    with recursive up (id) as (
      select p_retry_of
      union
      select n.retry_of from runs n join up on n.id = up.id where n.retry_of is not null
    )
    select 1 from up where id = r.id
  ) then
    raise exception 'a run can''t retry itself' using errcode = 'BL903';
  end if;
  update runs set retry_of = p_retry_of where id = r.id and retry_of is distinct from p_retry_of;
  return run_json(r.id);
end
$$;

-- The runs this one might retry: the lab's other runs, leaving out the ones that retry it,
-- its experiment's first, then the nearest day. p_query narrows to titles holding every word.
create function retry_candidates(p_run_id uuid, p_query text, p_limit int default 8) returns setof jsonb
language sql stable security invoker set search_path = public as $$
  with recursive me as (select id, lab_id, experiment_id, started_on from runs where id = p_run_id),
  down (id) as (
    select id from me
    union
    select n.id from runs n join down on n.retry_of = down.id
  ),
  words as (select w from regexp_split_to_table(lower(btrim(coalesce(p_query, ''))), '\s+') w where w <> '')
  select run_ref_json(r.id)
  from runs r join me on me.lab_id = r.lab_id
  where r.id not in (select id from down)
    and not exists (select 1 from words where strpos(lower(r.title), words.w) = 0)
  order by
    coalesce(r.experiment_id = me.experiment_id, false) desc,
    abs(coalesce(r.started_on, '1900-01-01'::date) - coalesce(me.started_on, current_date)),
    r.started_on desc nulls last,
    r.title
  limit least(greatest(p_limit, 1), 20)
$$;

-- The run a file belongs to, for the files asked about that have one: the newest run it is
-- evidence of. A shared control or a standard is in many runs and belongs to none of them.
create function file_runs(p_lab_id uuid, p_shas text[])
returns table (sha256 text, run_id uuid, title text, status run_status)
language sql stable security invoker set search_path = public as $$
  select distinct on (f.sha256) f.sha256, r.id, r.title, r.status
  from run_files f join runs r on r.id = f.run_id
  where f.lab_id = p_lab_id and f.sha256 = any (p_shas) and f.role = 'evidence'
  order by f.sha256, r.started_on desc nulls last, r.created_at desc, r.id
$$;

-- The lab's runs, newest first, as rows of a list. p_filter may hold status ('none' for runs
-- nobody has marked), technique, step, cause and experiment_id.
create function lab_runs(p_lab_id uuid, p_filter jsonb default '{}', p_limit int default 50, p_offset int default 0)
returns setof jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'id', r.id,
    'title', r.title,
    'started_on', r.started_on,
    'status', r.status,
    'experiment', e.name,
    'person', p.display_name,
    'files', (select count(*) from run_files f where f.run_id = r.id),
    'retry_of', run_ref_json(r.retry_of),
    'confirmed', r.confirmed_cause is not null,
    'technique', r.technique,
    'failed_step', r.failed_step,
    'cause_category', r.cause_category
  )
  from runs r
  left join experiments e on e.id = r.experiment_id
  left join people p on p.id = r.person_id
  where r.lab_id = p_lab_id
    and (p_filter ->> 'status' is null
      or (p_filter ->> 'status' = 'none' and r.status is null)
      or r.status::text = p_filter ->> 'status')
    and (p_filter ->> 'technique' is null or r.technique = p_filter ->> 'technique')
    and (p_filter ->> 'step' is null or r.failed_step = p_filter ->> 'step')
    and (p_filter ->> 'cause' is null or r.cause_category = p_filter ->> 'cause')
    and (p_filter ->> 'experiment_id' is null or r.experiment_id::text = p_filter ->> 'experiment_id')
  order by r.started_on desc nulls last, r.created_at desc, r.id
  limit least(greatest(p_limit, 1), 200)
  offset greatest(p_offset, 0)
$$;

-- "Turn these into runs?": files a person has already vouched for that say how they went and
-- aren't in a run. A confirmed note is one suggestion with its pages; any other file whose
-- label a person accepted or corrected is one by itself. Empty once the member has put the
-- list away. Nothing becomes a run until someone taps it (create_run).
create function run_suggestions(p_lab_id uuid, p_limit int default 20) returns setof jsonb
language sql stable security invoker set search_path = public as $$
  with open as (
    select not exists (
      select 1 from run_suggestion_dismissals d where d.lab_id = p_lab_id and d.user_id = auth.uid()
    ) as yes
  ),
  live as (
    select l.sha256, l.clean_name, l.date, l.outcome, l.status, l.updated_at
    from labels l
    where l.lab_id = p_lab_id
      and l.clean_name is not null
      and exists (select 1 from file_locations fl where fl.lab_id = p_lab_id and fl.sha256 = l.sha256 and fl.deleted_at is null)
      and not exists (select 1 from run_files f where f.lab_id = p_lab_id and f.sha256 = l.sha256)
      and not is_recording(p_lab_id, l.sha256)
  ),
  notes_open as (
    select n.id, array_agg(np.sha256 order by np.position) as shas
    from notes n
    join note_pages np on np.note_id = n.id and np.live
    where n.lab_id = p_lab_id and n.state = 'confirmed'
      and exists (select 1 from file_locations fl where fl.lab_id = p_lab_id and fl.sha256 = np.sha256 and fl.deleted_at is null)
    group by n.id
    having not bool_or(exists (select 1 from run_files f where f.lab_id = p_lab_id and f.sha256 = np.sha256))
  ),
  from_notes as (
    select 'note:' || g.id as key, g.shas, c.clean_name, c.date, c.outcome, c.updated_at
    from notes_open g join labels c on c.lab_id = p_lab_id and c.sha256 = g.shas[1]
    where c.outcome is not null and c.clean_name is not null
  ),
  from_files as (
    select 'file:' || l.sha256 as key, array[l.sha256] as shas, l.clean_name, l.date, l.outcome, l.updated_at
    from live l
    where l.outcome is not null and l.status in ('accepted', 'corrected')
      and not exists (
        select 1 from note_pages np join notes n on n.id = np.note_id
        where np.lab_id = p_lab_id and np.sha256 = l.sha256 and np.live and n.state = 'confirmed'
      )
  )
  select jsonb_build_object('key', s.key, 'shas', to_jsonb(s.shas), 'title', s.clean_name, 'date', s.date, 'file_says', s.outcome)
  from (select * from from_notes union all select * from from_files) s, open
  where open.yes
  order by s.date desc nulls last, s.updated_at desc, s.key
  limit least(greatest(p_limit, 1), 100)
$$;

-- Puts "Turn these into runs?" away for the caller, for good.
create function dismiss_run_suggestions(p_lab_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not is_lab_member(p_lab_id) then
    raise exception 'not a member of this lab' using errcode = '42501';
  end if;
  insert into run_suggestion_dismissals (lab_id, user_id) values (p_lab_id, auth.uid())
  on conflict do nothing;
end
$$;

-- What the run page needs to open one of a run's files as it was: the name it had and whether
-- its bytes are kept. Works after the file is gone from the lab's folder, because the run
-- holds it. No row for a file that isn't in the run, or for anyone outside the run's lab.
create function run_file(p_run_id uuid, p_sha256 text)
returns table (lab_id uuid, sha256 text, original_name text, mime text, kept boolean)
language sql stable security definer set search_path = public as $$
  select f.lab_id, f.sha256, v.original_name, b.mime, v.kept
  from run_files f
  join blobs b on b.sha256 = f.sha256
  cross join lateral (
    select (array_agg(fv.original_name order by fv.seen_at desc, fv.id))[1] as original_name,
      coalesce(bool_or(fv.kept_at is not null), false) as kept
    from file_versions fv where fv.lab_id = f.lab_id and fv.sha256 = f.sha256
  ) v
  where f.run_id = p_run_id and f.sha256 = p_sha256 and is_lab_member(f.lab_id)
$$;

-- ---------------------------------------------------------------------------------------
-- Grants. Members read the tables and call the functions below; everything else, the
-- triggers' functions and the worker's included, is for the owner only.

revoke all on
  failure_taxonomies, failure_terms, runs, run_files, run_log, run_debriefs, run_debrief_answers,
  run_suggestion_dismissals, export_exclusions, run_rubrics, run_reviews, task_exports, task_model_runs
from anon, authenticated;
revoke all on function
  run_files_check(), run_via(), runs_before_update(), runs_log(), run_files_log(), labs_sharing_log(),
  run_export_blocks(uuid), task_exports_check(), assert_exportable(uuid), task_model_runs_check(),
  member_run(uuid), is_recording(uuid, text), run_ref_json(uuid), run_json(uuid),
  put_run_files(uuid, uuid, text[], run_file_role), create_run(uuid, text[], jsonb),
  add_run_files(uuid, text[], run_file_role), remove_run_file(uuid, text),
  set_run_status(uuid, run_status, boolean), edit_run(uuid, jsonb), link_retry(uuid, uuid),
  retry_candidates(uuid, text, int), file_runs(uuid, text[]), lab_runs(uuid, jsonb, int, int),
  run_suggestions(uuid, int), dismiss_run_suggestions(uuid), run_file(uuid, text)
from public, anon, authenticated;

grant select on
  failure_taxonomies, failure_terms, runs, run_files, run_log, run_debriefs, run_debrief_answers,
  run_suggestion_dismissals, export_exclusions, run_rubrics, run_reviews, task_exports, task_model_runs
to authenticated;
grant execute on function
  is_recording(uuid, text), run_ref_json(uuid), run_json(uuid), create_run(uuid, text[], jsonb),
  add_run_files(uuid, text[], run_file_role), remove_run_file(uuid, text),
  set_run_status(uuid, run_status, boolean), edit_run(uuid, jsonb), link_retry(uuid, uuid),
  retry_candidates(uuid, text, int), file_runs(uuid, text[]), lab_runs(uuid, jsonb, int, int),
  run_suggestions(uuid, int), dismiss_run_suggestions(uuid), run_file(uuid, text)
to authenticated;
