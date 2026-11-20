-- Curve checks pick their fit and what they read from it, and control checks find their
-- controls by column as well as by row (decisions.md, "checks: curves, IC50s and blank
-- columns"). Mirrors CheckSpec in apps/web/src/lib/checks.ts.
--
-- A curve check may carry `fit` (line, log_line or 4pl) and `measure` (r2, midpoint or
-- outside), both or neither; a midpoint (IC50 or EC50) needs the 4PL, and samples outside the
-- standards need a line. A control check may carry `by` (row or column); by column it names
-- no column to read and no column of names. Checks saved before this carry none of the new
-- keys and mean what they always did: a line's R², controls by row. Versions are never
-- rewritten, so their stored checks keep their digests.

create or replace function check_spec_ok(c jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(c) = 'object'
    and (c ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(c -> 'name') = 'string'
    and length(btrim(c ->> 'name')) between 1 and 80
    and check_text_ok(c -> 'sheet', 200)
    and check_text_ok(c -> 'unit', 40)
    and check_range_ok(c -> 'range')
    and case c ->> 'kind'
      when 'curve_fit' then check_column_ok(c -> 'x', true) and check_column_ok(c -> 'y', true)
        and (c ? 'fit') = (c ? 'measure')
        and (not c ? 'fit' or (
          jsonb_typeof(c -> 'fit') = 'string' and jsonb_typeof(c -> 'measure') = 'string'
          and c ->> 'fit' in ('line', 'log_line', '4pl')
          and c ->> 'measure' in ('r2', 'midpoint', 'outside')
          and (c ->> 'measure' <> 'midpoint' or c ->> 'fit' = '4pl')
          and (c ->> 'measure' <> 'outside' or c ->> 'fit' <> '4pl')
        ))
      when 'peak' then check_column_ok(c -> 'x', true) and check_column_ok(c -> 'y', true)
      when 'value' then check_column_ok(c -> 'column', false)
        and c ->> 'stat' in ('mean', 'max', 'min', 'cell')
        and check_text_ok(c -> 'row', 120)
        and ((c ->> 'stat' = 'cell') = (jsonb_typeof(c -> 'row') = 'string'))
      when 'control' then jsonb_typeof(c -> 'pattern') = 'string'
        and length(btrim(c ->> 'pattern')) between 1 and 80
        and c ->> 'use' in ('each', 'mean')
        and (not c ? 'by' or (jsonb_typeof(c -> 'by') = 'string' and c ->> 'by' in ('row', 'column')))
        and case coalesce(c ->> 'by', 'row')
          when 'row' then check_column_ok(c -> 'labelColumn', true) and check_column_ok(c -> 'column', false)
          else jsonb_typeof(c -> 'labelColumn') = 'null' and jsonb_typeof(c -> 'column') = 'null'
        end
      else false
    end,
    false
  )
$$;
