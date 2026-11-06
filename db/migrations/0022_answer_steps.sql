-- The steps behind an answer (decisions.md, "asking the lab, and suggestions that wait for
-- approval"): the search, the files, protocols and tables it read, and whether the model wrote
-- the answer or it came from the cache. The page shows them while the answer streams; saved
-- here, a question opened again from Recent questions shows the same steps instead of
-- inventing them from its sources. [{"kind", "id", ...}], as lib/answers.ts AskStep; answers
-- saved before this have none.
alter table questions add column steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array');

-- record_answer gains p_steps. Dropped and made again since the signature changes; the
-- default keeps a call without steps working.
drop function record_answer(uuid, uuid, text, answer_outcome, jsonb, jsonb, int, int, text, boolean, int, jsonb);

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
  p_call jsonb,
  p_steps jsonb default '[]'::jsonb
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
    dropped_sentences, model, cached, cost_usd, latency_ms, steps)
  values (p_lab_id, p_user_id, btrim(p_question), p_outcome, p_answer, p_sources, p_dropped_citations,
    p_dropped_sentences, p_model, p_cached, v_cost, p_latency_ms, coalesce(p_steps, '[]'::jsonb))
  returning id into v_id;
  insert into audit_log (lab_id, actor, action, target) values (p_lab_id, p_user_id, 'question.ask', v_id::text);
  return v_id;
end
$$;

revoke all on function record_answer(uuid, uuid, text, answer_outcome, jsonb, jsonb, int, int, text, boolean, int, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function record_answer(uuid, uuid, text, answer_outcome, jsonb, jsonb, int, int, text, boolean, int, jsonb, jsonb)
to service_role;
