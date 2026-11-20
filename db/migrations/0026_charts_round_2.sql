-- Charts round 2 (decisions.md, "charts round 2"): chart specs gain the heatmap of any two
-- columns that sort the rows (`grid`), and a line or scatter chart may draw the same columns
-- from other files (`runs`, by content hash, up to 11 beside the chart's own file). Everything
-- 0023's chart_spec_ok accepted still passes; the new keys mirror ChartSpec in
-- apps/web/src/lib/charts.ts key for key.

create or replace function chart_spec_ok(s jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(s) = 'object'
    and length(s::text) <= 64000
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
      when s ->> 'type' = 'grid' then
        (s ->> 'rows') ~ '^[A-Z]{1,3}$'
        and (s ->> 'columns') ~ '^[A-Z]{1,3}$'
        and (s ->> 'measure') ~ '^[A-Z]{1,3}$'
        and s ->> 'rows' <> s ->> 'columns'
        and jsonb_typeof(s -> 'value') = 'object'
        and jsonb_typeof(s -> 'value' -> 'title') = 'string' and length(btrim(s #>> '{value,title}')) <= 80
        and jsonb_typeof(s -> 'value' -> 'unit') = 'string' and length(btrim(s #>> '{value,unit}')) <= 24
        and jsonb_typeof(s -> 'value' -> 'min') in ('null', 'number')
        and jsonb_typeof(s -> 'value' -> 'max') in ('null', 'number')
      when s ->> 'type' in ('line', 'scatter', 'bar') then
        s ->> 'legend' in ('top', 'right', 'bottom')
        and jsonb_typeof(s -> 'x') = 'object'
        and (s -> 'x' ->> 'column') ~ '^[A-Z]{1,3}$'
        and coalesce(s -> 'x' ->> 'scale', 'linear') in ('linear', 'log')
        and not (s ->> 'type' = 'bar' and coalesce(s -> 'x' ->> 'scale', 'linear') = 'log')
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
        and (s -> 'runs' is null
          or (s ->> 'type' <> 'bar'
            and jsonb_typeof(s -> 'runs') = 'array'
            and jsonb_array_length(s -> 'runs') <= 11
            and not exists (select 1 from jsonb_array_elements(s -> 'runs') r where jsonb_typeof(r) <> 'string' or (r #>> '{}') !~ '^[0-9a-f]{64}$')
            and (select count(distinct r) from jsonb_array_elements_text(s -> 'runs') r) = jsonb_array_length(s -> 'runs')))
      when s ->> 'type' in ('groups', 'curve', 'band', 'dose') then
        chart_source_ok(s -> 'source')
        and s ->> 'spread' in ('sd', 'sem', 'ci')
        and jsonb_typeof(s -> 'points') = 'boolean'
        and jsonb_typeof(s -> 'blank') = 'boolean'
        and chart_axis_ok(s -> 'y')
        and case s ->> 'type'
          when 'groups' then
            s ->> 'mark' in ('bar', 'box')
            and s ->> 'test' in ('none', 'welch', 'anova', 'control')
            and (jsonb_typeof(s -> 'control') = 'null' or (jsonb_typeof(s -> 'control') = 'string' and length(s ->> 'control') <= 80))
            and jsonb_typeof(s -> 'marks') = 'boolean'
            and jsonb_typeof(s -> 'x') = 'object' and jsonb_typeof(s -> 'x' -> 'title') = 'string' and length(btrim(s #>> '{x,title}')) <= 80
            and not (s ->> 'mark' = 'bar' and s -> 'y' ->> 'scale' = 'log')
          when 'curve' then
            chart_axis_ok(s -> 'x')
            and s ->> 'fit' in ('none', 'line', 'origin')
            and (jsonb_typeof(s -> 'unknowns') = 'null'
              or (jsonb_typeof(s -> 'unknowns') = 'object' and case s #>> '{unknowns,kind}'
                when 'layout' then s #>> '{source,kind}' = 'plate'
                when 'table' then length(s #>> '{unknowns,table}') between 1 and 200
                  and (s #>> '{unknowns,label}') ~ '^[A-Z]{1,3}$'
                  and (s #>> '{unknowns,value}') ~ '^[A-Z]{1,3}$'
                  and (jsonb_typeof(s #> '{unknowns,dilution}') = 'null' or (s #>> '{unknowns,dilution}') ~ '^[A-Z]{1,3}$')
                else false end))
          when 'band' then
            chart_axis_ok(s -> 'x')
            and jsonb_typeof(s -> 'band') = 'boolean'
            and s ->> 'legend' in ('top', 'right', 'bottom')
          when 'dose' then
            chart_axis_ok(s -> 'x')
            and s -> 'x' ->> 'scale' = 'log'
            and s ->> 'fit' in ('points', 'means')
          else false
        end
      when s ->> 'type' = 'histogram' then
        (s ->> 'column') ~ '^[A-Z]{1,3}$'
        and (jsonb_typeof(s -> 'bin') = 'null' or (jsonb_typeof(s -> 'bin') = 'number' and (s ->> 'bin')::numeric > 0))
        and jsonb_typeof(s -> 'x') = 'object'
        and jsonb_typeof(s -> 'x' -> 'title') = 'string' and length(btrim(s #>> '{x,title}')) <= 80
        and jsonb_typeof(s -> 'x' -> 'unit') = 'string' and length(btrim(s #>> '{x,unit}')) <= 24
        and jsonb_typeof(s -> 'y') = 'object' and jsonb_typeof(s -> 'y' -> 'title') = 'string'
      else false
    end,
    false
  )
$$;
