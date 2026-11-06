-- The rest of charts and videos (decisions.md, "dates along x", "per-series x columns", "plate
-- heatmaps", "more than six series", "re-parsing tables" and "steps from a video").

-- Chart specs, mirroring ChartSpec in apps/web/src/lib/charts.ts. An x/y chart's series may
-- name a stroke (a line chart's second six are dashed) and its own x column; old specs have
-- neither and keep the shared x and a solid line. Lines take 12 series, bars 6, a scatter 3. A
-- plate heatmap names its size and where its wells are read from. The check constraint on
-- charts.spec calls this function, so new writes are checked against it; rows already saved
-- passed the old one, which this one accepts too.
create or replace function chart_spec_ok(s jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(s) = 'object'
    and length(s::text) <= 16000
    and s ->> 'version' = '1'
    and case
      when s ->> 'type' = 'heatmap' then
        jsonb_typeof(s -> 'plate') = 'object'
        and s -> 'plate' ->> 'size' in ('96', '384')
        and jsonb_typeof(s -> 'plate' -> 'source') = 'object'
        and case s #>> '{plate,source,kind}'
          when 'grid' then (s #>> '{plate,source,rows}') ~ '^[A-Z]{1,3}$'
          when 'wells' then (s #>> '{plate,source,well}') ~ '^[A-Z]{1,3}$' and (s #>> '{plate,source,value}') ~ '^[A-Z]{1,3}$'
          when 'read' then
            case when jsonb_typeof(s #> '{plate,source,row}') = 'number'
              then (s #>> '{plate,source,row}')::numeric between 0 and 1000000
                and (s #>> '{plate,source,row}')::numeric = floor((s #>> '{plate,source,row}')::numeric)
              else false end
          else false
        end
        and jsonb_typeof(s -> 'value') = 'object'
      when s ->> 'type' in ('line', 'scatter', 'bar') then
        s ->> 'legend' in ('top', 'right', 'bottom')
        and jsonb_typeof(s -> 'x') = 'object'
        and (s -> 'x' ->> 'column') ~ '^[A-Z]{1,3}$'
        and jsonb_typeof(s -> 'y') = 'object'
        and s -> 'y' ->> 'scale' in ('linear', 'log')
        and not (s ->> 'type' = 'bar' and s -> 'y' ->> 'scale' = 'log')
        and jsonb_typeof(s -> 'series') = 'array'
        and jsonb_array_length(s -> 'series') between 1
          and (case s ->> 'type' when 'scatter' then 3 when 'bar' then 6 else 12 end)
        and not exists (
          select 1 from jsonb_array_elements(s -> 'series') e
          where not coalesce(
            jsonb_typeof(e) = 'object'
            and (e ->> 'column') ~ '^[A-Z]{1,3}$'
            and length(btrim(e ->> 'name')) between 1 and 80
            and e ->> 'color' in ('blue', 'orange', 'aqua', 'violet', 'magenta', 'green')
            and coalesce(e ->> 'stroke', 'solid') in ('solid', 'dashed')
            and (s ->> 'type' = 'line' or coalesce(e ->> 'stroke', 'solid') = 'solid')
            and (jsonb_typeof(e -> 'error') = 'null' or (e ->> 'error') ~ '^[A-Z]{1,3}$')
            and (e -> 'x' is null or jsonb_typeof(e -> 'x') = 'null'
              or (s ->> 'type' <> 'bar' and (e ->> 'x') ~ '^[A-Z]{1,3}$')),
            false
          )
        )
      else false
    end,
    false
  )
$$;

-- Re-parsing after a parser version bump (decisions.md, "re-parsing tables"). The worker's
-- sweep reads stale tables again, those used longest ago first; one a newer parser couldn't
-- read keeps its old table, and the row records which version tried and why, so the sweep
-- moves on and doesn't try that version again. The stale rows are found by this index.
alter table data_tables
  add column reparse_version int,
  add column reparse_error text check (reparse_error is null or length(reparse_error) <= 500),
  add constraint data_tables_reparse_check check ((reparse_version is null) = (reparse_error is null));
create index data_tables_parser_idx on data_tables (parser_version) where state in ('ready', 'failed');
