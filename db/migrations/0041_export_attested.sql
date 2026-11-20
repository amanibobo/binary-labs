-- The confirmer's own tap is part of the consent rule itself, so the database refuses a folder
-- or a model check for a run whose confirmed cause nobody attested, at the moment it is built.
-- Before this only the gate asked, so a grant made while the cause was attested still built a
-- folder after the cause changed (decisions.md, "the run record: sharing and the gate").
create or replace function run_export_blocks(p_run_id uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select array_remove(array[
    case when not r.share then 'run_off' end,
    case when l.sharing_agreed_at is null then 'lab_off' end,
    case when l.plan = 'demo' then 'demo_lab' end,
    case when r.confirmed_cause is not null and r.confirmer_attested_at is null then 'not_attested' end
  ], null)
  from runs r join labs l on l.id = r.lab_id
  where r.id = p_run_id
$$;

create or replace function run_share_blocks(p_run_id uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select run_export_blocks(p_run_id)
$$;
