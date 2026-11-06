"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import {
  CHART_TYPE_NAMES,
  chartHref,
  chartTrouble,
  checkSpec,
  LEGEND_POSITIONS,
  MAX_SERIES,
  nextStyle,
  PALETTE,
  repairSpec,
  SERIES_COLORS,
  specProblem,
  startingSpec,
  titleFromName,
  withType,
  XY_TYPES,
  type ChartSpec,
  type ChartType,
  type HeatmapSpec,
  type LegendPosition,
  type SavedChart,
  type Series,
  type SeriesColor,
  type Stroke,
  type XYSpec,
} from "@/lib/charts";
import { formatValue } from "@/lib/chart-geometry";
import { axisColumns, columnLabel, findColumn, formatDate, mainTable, type DataColumn, type DataTable, type DataTables } from "@/lib/data-tables";
import type { ColumnId, LocationId, ProtocolId, Sha256 } from "@/lib/ids";
import { plateLayout, type PlateLayout } from "@/lib/plates";
import { protocolHref } from "@/lib/protocols";
import { DeleteIcon } from "../icons/base-web";
import { useLabApi } from "../lab-api";
import { Breadcrumbs } from "../ui/breadcrumbs";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDock } from "../ui/dialog";
import { Input, inputVariants } from "../ui/field";
import { Skeleton } from "../ui/skeleton";
import { ChartFigure } from "./chart-figure";
import { fileChartsKey } from "./file-charts";
import { chartMarkup, downloadPng, downloadSvg } from "./chart-export";

const POLL_MS = 2_000;

export const tableKey = (sha: Sha256) => ["data-table", sha] as const;

export type ChartFile = { locationId: LocationId | null; sha256: Sha256; name: string };
export type ProtocolChoice = { id: ProtocolId; title: string };
export type BuilderMode = { kind: "create"; protocolId: ProtocolId | null } | { kind: "edit"; chart: SavedChart };

export function fileHref(file: ChartFile): string {
  return `/?${new URLSearchParams({ q: file.name, open: file.sha256 })}`;
}

// The chart builder: the file's table on the left, the live chart and its settings on the
// right. It opens once the worker has the file's full table, asking for it when the file was
// indexed before charts existed.
export function ChartBuilder({ file, mode, protocols }: { file: ChartFile; mode: BuilderMode; protocols: readonly ProtocolChoice[] }) {
  const api = useLabApi();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: tableKey(file.sha256),
    queryFn: ({ signal }) => api.dataTable(file.sha256, signal),
    refetchInterval: (q) => (q.state.data?.state === "waiting" || q.state.data?.state === "missing" ? POLL_MS : false),
  });
  const state = query.data;
  const asked = useRef(false);

  async function ask() {
    try {
      await api.requestDataTable(file.sha256);
      await queryClient.invalidateQueries({ queryKey: tableKey(file.sha256) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't ask for this file's table.");
    }
  }

  useEffect(() => {
    if (state?.state !== "missing" || asked.current) return;
    asked.current = true;
    void ask();
  });

  const title = mode.kind === "edit" ? mode.chart.title : "New chart";
  const crumbs = <ChartCrumbs file={file} title={title} />;

  if (query.isError) {
    return (
      <Shell crumbs={crumbs}>
        <Message>We couldn&apos;t load this file&apos;s table. Reload the page to try again.</Message>
      </Shell>
    );
  }
  if (state === undefined || state.state === "missing" || state.state === "waiting") {
    return (
      <Shell crumbs={crumbs}>
        <p className="text-paragraph-medium text-content-secondary" role="status">
          Reading the table in {file.name}…
        </p>
        <Skeleton className="mt-6 h-80 w-full rounded-card" />
      </Shell>
    );
  }
  if (state.state === "failed") {
    return (
      <Shell crumbs={crumbs}>
        <Message>{state.error}</Message>
        <Button variant="secondary" size="compact" className="mt-4" onClick={() => void ask()}>
          Try again
        </Button>
      </Shell>
    );
  }
  const saved = mode.kind === "edit" ? (state.tables.tables.find((t) => t.name === mode.chart.sheet) ?? null) : null;
  const first = saved ?? mainTable(state.tables);
  if (first === null) {
    return (
      <Shell crumbs={crumbs}>
        <Message>There&apos;s no table of numbers in this file to chart.</Message>
      </Shell>
    );
  }
  return <Builder file={file} mode={mode} protocols={protocols} doc={state.tables} first={first} />;
}

function Shell({ crumbs, children }: { crumbs: ReactNode; children: ReactNode }) {
  return (
    <>
      {crumbs}
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-24 sm:px-8">{children}</div>
    </>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <p className="max-w-xl text-paragraph-medium text-content-secondary">{children}</p>;
}

function ChartCrumbs({ file, title }: { file: ChartFile; title: string }) {
  return (
    <div className="border-b border-border-opaque">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center px-4 sm:px-8">
        <Breadcrumbs
          items={[...(file.locationId === null ? [] : [{ label: file.name, href: fileHref(file) }]), { label: title, href: "#" }]}
        />
      </div>
    </div>
  );
}

type Draft = { sheet: string; title: string; spec: ChartSpec | null; protocolId: ProtocolId | null };

// A column's name is what the axis title starts as, until someone types their own.
function isAutoTitle(title: string, table: DataTable): boolean {
  return title.trim() === "" || table.columns.some((c) => c.name === title.trim());
}

function withAxisFrom(spec: XYSpec, table: DataTable): XYSpec {
  const only = spec.series.length === 1 ? findColumn(table, spec.series[0].column) : undefined;
  const x = findColumn(table, spec.x.column);
  return {
    ...spec,
    x: x !== undefined && isAutoTitle(spec.x.title, table) ? { ...spec.x, title: x.name, unit: x.unit ?? "" } : spec.x,
    y: only !== undefined && isAutoTitle(spec.y.title, table) ? { ...spec.y, title: only.name, unit: only.unit ?? "" } : spec.y,
  };
}

const seriesLimit = (type: XYSpec["type"]) =>
  type === "scatter" ? "A scatter chart takes up to three series." : `A ${type} chart takes up to ${MAX_SERIES[type]} series.`;

function Builder({
  file,
  mode,
  protocols,
  doc,
  first,
}: {
  file: ChartFile;
  mode: BuilderMode;
  protocols: readonly ProtocolChoice[];
  doc: DataTables;
  first: DataTable;
}) {
  const api = useLabApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState<SavedChart | null>(mode.kind === "edit" ? mode.chart : null);
  const [draft, setDraft] = useState<Draft>(() =>
    mode.kind === "edit"
      ? { sheet: mode.chart.sheet, title: mode.chart.title, spec: mode.chart.spec, protocolId: mode.chart.protocolId }
      : { sheet: first.name, title: titleFromName(file.name), spec: startingSpec(first), protocolId: mode.protocolId },
  );
  // The x/y chart while a plate is shown, and the other way round, so switching back keeps it.
  const other = useRef<ChartSpec | null>(null);
  const [saving, setSaving] = useState(false);
  const table = doc.tables.find((t) => t.name === draft.sheet) ?? first;
  const spec = draft.spec;
  const problem = spec === null ? "There's nothing in this table to plot yet. Pick another sheet." : (specProblem(spec) ?? checkSpec(spec, table));
  const dirty =
    saved === null ||
    JSON.stringify({ sheet: saved.sheet, title: saved.title, spec: saved.spec, protocolId: saved.protocolId }) !== JSON.stringify(draft);
  // A saved chart whose file was read again and no longer fits says why, until it's fixed.
  const broken = saved !== null && !dirty ? chartTrouble(saved, doc.tables) : null;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const editSpec = (f: (s: ChartSpec) => ChartSpec) => setDraft((d) => (d.spec === null ? d : { ...d, spec: f(d.spec) }));
  const editXY = (f: (s: XYSpec) => XYSpec) => editSpec((s) => (s.type === "heatmap" ? s : f(s)));
  const editPlate = (f: (s: HeatmapSpec) => HeatmapSpec) => editSpec((s) => (s.type === "heatmap" ? f(s) : s));

  function chooseTable(name: string) {
    const next = doc.tables.find((t) => t.name === name);
    if (next === undefined) return;
    other.current = null;
    setDraft((d) => ({ ...d, sheet: name, spec: startingSpec(next) }));
  }

  function chooseType(type: ChartType) {
    if (spec === null) return;
    const keep = (spec.type === "heatmap") !== (type === "heatmap") ? spec : other.current;
    const next = withType(spec, type, table, other.current);
    other.current = keep;
    setDraft((d) => ({ ...d, spec: next }));
  }

  function fix() {
    const mended = spec === null ? null : repairSpec(spec, table);
    setDraft((d) => ({ ...d, sheet: table.name, spec: mended ?? startingSpec(table) }));
  }

  function togglePlot(column: DataColumn) {
    if (spec === null || column.kind !== "number") return;
    if (spec.type === "heatmap") {
      if (spec.plate.source.kind !== "wells") return;
      const source = { ...spec.plate.source, value: column.id };
      editPlate((s) => ({ ...s, plate: { ...s.plate, source }, value: { ...s.value, title: column.name, unit: column.unit ?? "" } }));
      return;
    }
    if (column.id === spec.x.column) return;
    const plotted = spec.series.some((s) => s.column === column.id);
    if (!plotted && spec.series.length >= MAX_SERIES[spec.type]) {
      toast(seriesLimit(spec.type));
      return;
    }
    editXY((s) =>
      withAxisFrom(
        {
          ...s,
          series: plotted
            ? s.series.filter((q) => q.column !== column.id)
            : [...s.series, { column: column.id, name: column.name, ...nextStyle(s.series, s.type), error: null, x: null }],
        },
        table,
      ),
    );
  }

  async function save() {
    if (spec === null || problem !== null) return;
    if (draft.title.trim() === "") {
      toast.error("Give the chart a title.");
      return;
    }
    setSaving(true);
    try {
      const fields = { sheet: draft.sheet, title: draft.title, spec, protocolId: draft.protocolId };
      if (saved === null) {
        const chart = await api.createChart({ sha256: file.sha256, ...fields });
        setSaved(chart);
        void queryClient.invalidateQueries({ queryKey: fileChartsKey(file.sha256) });
        toast.success("Chart saved");
        router.replace(chartHref(chart.id));
        return;
      }
      const outcome = await api.saveChart(saved.id, { ...fields, basedOn: saved.updatedAt });
      if (outcome.kind === "stale") {
        toast.error("Someone saved this chart since you opened it. Reload to see theirs.");
        return;
      }
      setSaved(outcome.chart);
      setDraft({ sheet: outcome.chart.sheet, title: outcome.chart.title, spec: outcome.chart.spec, protocolId: outcome.chart.protocolId });
      void queryClient.invalidateQueries({ queryKey: fileChartsKey(file.sha256) });
      toast.success("Chart saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save that chart.");
    } finally {
      setSaving(false);
    }
  }

  async function exportAs(kind: "svg" | "png") {
    if (spec === null || problem !== null) return;
    const figure = chartMarkup(spec, table, draft.title.trim() || "Chart");
    try {
      if (kind === "svg") downloadSvg(figure, draft.title);
      else await downloadPng(figure, draft.title);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't make that file.");
    }
  }

  const layout = useMemo(() => plateLayout(table), [table]);
  const types: ChartType[] = layout === null ? [...XY_TYPES] : [...XY_TYPES, "heatmap"];
  const titleId = useId();
  return (
    <>
      <ChartCrumbs file={file} title={saved?.title ?? "New chart"} />
      <div className="mx-auto grid w-full max-w-6xl gap-x-10 gap-y-10 px-4 pt-8 pb-24 sm:px-8 lg:grid-cols-[288px_minmax(0,1fr)]">
        <aside aria-label="Data" className="order-2 min-w-0 lg:sticky lg:top-6 lg:order-1 lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto lg:pr-2">
          <DataPanel doc={doc} table={table} spec={spec} onChooseTable={chooseTable} onTogglePlot={togglePlot} />
        </aside>
        <div className="order-1 min-w-0 lg:order-2">
          <label htmlFor={titleId} className="sr-only">
            Chart title
          </label>
          <input
            id={titleId}
            value={draft.title}
            maxLength={200}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            placeholder="Chart title"
            className="-mx-2 w-[calc(100%+16px)] rounded-control bg-transparent px-2 py-1 text-heading-small text-content-primary placeholder:text-content-tertiary hover:bg-background-secondary focus:bg-background-secondary focus-visible:outline-none sm:text-heading-medium"
          />
          {broken === null ? null : (
            <div role="alert" className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-control border border-border-opaque bg-background-secondary px-4 py-3">
              <p className="min-w-0 flex-1 text-paragraph-small text-content-secondary">{broken}</p>
              <Button size="compact" variant="secondary" onClick={fix}>
                Fix the chart
              </Button>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            {spec === null ? (
              <span />
            ) : (
              <Segmented label="Chart type" options={types.map((t) => ({ value: t, label: CHART_TYPE_NAMES[t] }))} value={spec.type} onChange={chooseType} />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="tertiary" size="compact" disabled={problem !== null} onClick={() => void exportAs("svg")}>
                Export SVG
              </Button>
              <Button variant="tertiary" size="compact" disabled={problem !== null} onClick={() => void exportAs("png")}>
                Export PNG
              </Button>
              <Button size="compact" disabled={saving || problem !== null || !dirty} onClick={() => void save()}>
                {saving ? "Saving" : saved !== null && !dirty ? "Saved" : "Save"}
              </Button>
            </div>
          </div>
          <div className="mt-6">
            {spec === null || problem !== null ? (
              <div className="flex min-h-64 items-center justify-center rounded-card border border-border-opaque px-6 text-center">
                <p className="max-w-sm text-paragraph-medium text-content-secondary">{problem}</p>
              </div>
            ) : (
              <ChartFigure spec={spec} table={table} label={draft.title || "Chart"} />
            )}
          </div>
          {spec === null ? null : spec.type === "heatmap" ? (
            <PlateSettings spec={spec} table={table} layout={layout} onChange={editPlate} />
          ) : (
            <XYSettings spec={spec} table={table} onChange={editXY} />
          )}
          {spec === null ? null : (
            <ProtocolSetting protocols={protocols} protocolId={draft.protocolId} onProtocol={(protocolId) => setDraft((d) => ({ ...d, protocolId }))} />
          )}
          {saved === null ? null : <DeleteChart chart={saved} file={file} />}
        </div>
      </div>
    </>
  );
}

function DataPanel({
  doc,
  table,
  spec,
  onChooseTable,
  onTogglePlot,
}: {
  doc: DataTables;
  table: DataTable;
  spec: ChartSpec | null;
  onChooseTable: (name: string) => void;
  onTogglePlot: (column: DataColumn) => void;
}) {
  const sheetId = useId();
  const [allNotes, setAllNotes] = useState(false);
  const [find, setFind] = useState("");
  const findId = useId();
  const needle = find.trim().toLowerCase();
  const columns = needle === "" ? table.columns : table.columns.filter((c) => `${c.id} ${columnLabel(c)}`.toLowerCase().includes(needle));
  const notes = allNotes ? table.notes : table.notes.slice(0, 3);
  const plate = spec?.type === "heatmap";
  return (
    <div>
      {doc.tables.length > 1 ? (
        <div className="mb-6">
          <label htmlFor={sheetId} className="text-label-small text-content-secondary">
            Sheet
          </label>
          <select id={sheetId} value={table.name} onChange={(e) => onChooseTable(e.target.value)} className={cn(inputVariants({ size: "compact" }), "mt-1.5")}>
            {doc.tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {table.notes.length === 0 ? null : (
        <div className="mb-6 text-paragraph-xsmall text-content-tertiary">
          {notes.map((n, i) => (
            <p key={i} className="[overflow-wrap:anywhere]">
              {n}
            </p>
          ))}
          {table.notes.length > 3 ? (
            <button type="button" onClick={() => setAllNotes((v) => !v)} className="mt-1 text-content-accent underline-offset-2 hover:underline">
              {allNotes ? "Show less" : `Show all ${table.notes.length} lines`}
            </button>
          ) : null}
        </div>
      )}
      <h2 className="text-label-medium text-content-primary">Columns</h2>
      <p className="mt-1 text-paragraph-xsmall text-content-tertiary">
        {table.rows.toLocaleString("en-US")} rows.{" "}
        {plate ? (spec.plate.source.kind === "wells" ? "Tick a column to color the wells by it." : "") : "Tick a column to plot it."}
      </p>
      {table.columns.length > 12 ? (
        <div className="mt-3">
          <label htmlFor={findId} className="sr-only">
            Find a column
          </label>
          <Input id={findId} size="compact" type="search" placeholder="Find a column" value={find} onChange={(e) => setFind(e.target.value)} />
        </div>
      ) : null}
      <ul className="mt-3 grid">
        {columns.length === 0 ? <li className="px-2 py-2 text-paragraph-small text-content-tertiary">No column called that.</li> : null}
        {columns.map((c) => (
          <ColumnRow key={c.id} column={c} spec={spec} onToggle={() => onTogglePlot(c)} />
        ))}
      </ul>
    </div>
  );
}

const KIND_WORD = { number: "Numbers", date: "Dates", text: "Text" } satisfies Record<DataColumn["kind"], string>;

function columnRole(column: DataColumn, spec: ChartSpec | null): { checked: boolean; plottable: boolean; role: string | null; color: SeriesColor | null; stroke: Stroke } {
  if (spec === null) return { checked: false, plottable: false, role: null, color: null, stroke: "solid" };
  if (spec.type === "heatmap") {
    const source = spec.plate.source;
    const isValue = source.kind === "wells" && source.value === column.id;
    const role = source.kind === "wells" && source.well === column.id ? "Wells" : source.kind === "grid" && source.rows === column.id ? "Plate rows" : isValue ? "Colors the wells" : null;
    return { checked: isValue, plottable: source.kind === "wells" && column.kind === "number", role, color: null, stroke: "solid" };
  }
  const series = spec.series.find((s) => s.column === column.id);
  const isX = spec.x.column === column.id;
  const ownX = spec.series.find((s) => s.x === column.id);
  return {
    checked: series !== undefined,
    plottable: column.kind === "number" && !isX,
    role: isX ? "Along x" : ownX !== undefined ? `Along x for ${ownX.name}` : null,
    color: series?.color ?? null,
    stroke: series?.stroke ?? "solid",
  };
}

function ColumnRow({ column, spec, onToggle }: { column: DataColumn; spec: ChartSpec | null; onToggle: () => void }) {
  const id = useId();
  const { checked, plottable, role, color, stroke } = columnRole(column, spec);
  const blanks = column.values.filter((v) => v === null).length - column.invalid;
  const meta = [
    role ?? KIND_WORD[column.kind],
    column.invalid > 0 ? `${column.invalid} not ${column.kind === "date" ? "dates" : "numbers"}` : null,
    blanks > 0 ? `${blanks} blank` : null,
  ].filter((m): m is string => m !== null);
  return (
    <li>
      <label
        htmlFor={id}
        className={cn(
          "flex min-h-11 items-start gap-3 rounded-control px-2 py-2 sm:min-h-0",
          plottable ? "cursor-pointer hover:bg-background-secondary" : "cursor-default",
        )}
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={!plottable}
          onChange={onToggle}
          className="mt-0.5 size-4 shrink-0 accent-[var(--content-primary)] disabled:opacity-40"
        />
        <span className="w-6 shrink-0 font-mono text-paragraph-xsmall leading-5 text-content-tertiary">{column.id}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label-small text-content-primary">{columnLabel(column)}</span>
          <span className="block text-paragraph-xsmall text-content-tertiary">{meta.join(" · ")}</span>
          {column.note === null ? null : <span className="mt-0.5 block text-paragraph-xsmall text-content-tertiary">{column.note}</span>}
        </span>
        {color === null ? null : (
          <svg aria-hidden width={16} height={4} className="mt-2 shrink-0">
            <line x1={0} x2={16} y1={2} y2={2} stroke={`var(--chart-${color})`} strokeWidth={2} strokeDasharray={stroke === "dashed" ? "4 2" : undefined} />
          </svg>
        )}
      </label>
    </li>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-control bg-background-secondary p-0.5 ring-1 ring-border-opaque ring-inset">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "min-h-10 rounded-[8px] px-3 text-label-small transition-colors duration-150 ease-out sm:min-h-7",
            o.value === value ? "bg-background-raised text-content-primary shadow-raised" : "text-content-secondary hover:text-content-primary",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function XYSettings({ spec, table, onChange }: { spec: XYSpec; table: DataTable; onChange: (f: (s: XYSpec) => XYSpec) => void }) {
  const numbers = table.columns.filter((c) => c.kind === "number");
  const xChoices = spec.type === "bar" ? table.columns : axisColumns(table);
  const xColumn = findColumn(table, spec.x.column);
  const isTime = xColumn?.kind === "date" && spec.type !== "bar";
  const unplotted = numbers.filter((c) => c.id !== spec.x.column && !spec.series.some((s) => s.column === c.id));
  const editSeries = (column: ColumnId, f: (s: Series) => Series) =>
    onChange((s) => ({ ...s, series: s.series.map((q) => (q.column === column ? f(q) : q)) }));
  // Columns a series could read along instead of the chart's x: the same kind as x.
  const ownXChoices = axisColumns(table).filter((c) => c.kind === xColumn?.kind && c.id !== spec.x.column);

  return (
    <div className="mt-10 grid gap-10">
      <section aria-labelledby="series-heading">
        <h2 id="series-heading" className="text-heading-xsmall">
          Series
        </h2>
        <ul className="mt-4 grid gap-5">
          {spec.series.map((s) => (
            <SeriesRow
              key={s.column}
              spec={spec}
              series={s}
              table={table}
              numbers={numbers}
              ownXChoices={spec.type === "bar" ? [] : ownXChoices}
              onChange={(f) => editSeries(s.column, f)}
              onRemove={spec.series.length > 1 ? () => onChange((q) => withAxisFrom({ ...q, series: q.series.filter((x) => x.column !== s.column) }, table)) : null}
            />
          ))}
        </ul>
        {unplotted.length > 0 && spec.series.length < MAX_SERIES[spec.type] ? (
          <AddSeries
            choices={unplotted}
            onAdd={(c) =>
              onChange((q) =>
                withAxisFrom({ ...q, series: [...q.series, { column: c.id, name: c.name, ...nextStyle(q.series, q.type), error: null, x: null }] }, table),
              )
            }
          />
        ) : null}
        {spec.series.length > 6 ? (
          <p className="mt-3 text-paragraph-xsmall text-content-tertiary">Past six lines the colors come round again, dashed.</p>
        ) : null}
        {spec.series.length >= 2 ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <span className="text-label-small text-content-secondary">Legend</span>
            <Segmented<LegendPosition>
              label="Legend"
              options={LEGEND_POSITIONS.map((p) => ({ value: p, label: p === "top" ? "Top" : p === "right" ? "Right" : "Bottom" }))}
              value={spec.legend}
              onChange={(legend) => onChange((q) => ({ ...q, legend }))}
            />
          </div>
        ) : null}
      </section>

      <div className="grid gap-10 md:grid-cols-2">
        <section aria-labelledby="x-heading">
          <h2 id="x-heading" className="text-heading-xsmall">
            Horizontal axis
          </h2>
          <div className="mt-4 grid gap-4">
            <Field label="Column">
              {(id) => (
                <select
                  id={id}
                  value={spec.x.column}
                  onChange={(e) => {
                    const column = table.columns.find((c) => c.id === e.target.value);
                    if (column === undefined) return;
                    onChange((q) =>
                      withAxisFrom(
                        {
                          ...q,
                          x: { ...q.x, column: column.id, min: null, max: null },
                          // A series' own x has to be the same kind as the chart's.
                          series: q.series
                            .filter((x) => x.column !== column.id)
                            .map((x) => ({ ...x, x: x.x === column.id || findColumn(table, x.x ?? column.id)?.kind !== column.kind ? null : x.x })),
                        },
                        table,
                      ),
                    );
                  }}
                  className={inputVariants({ size: "compact" })}
                >
                  {xChoices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} · {columnLabel(c)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <TitleAndUnit axis={spec.x} noUnit={isTime} onChange={(x) => onChange((q) => ({ ...q, x: { ...q.x, ...x } }))} />
            {spec.type === "bar" ? null : (
              <Range axis={spec.x} time={isTime ? (xColumn?.kind === "date" ? xColumn.time : false) : null} onChange={(x) => onChange((q) => ({ ...q, x: { ...q.x, ...x } }))} />
            )}
          </div>
        </section>
        <section aria-labelledby="y-heading">
          <h2 id="y-heading" className="text-heading-xsmall">
            Vertical axis
          </h2>
          <div className="mt-4 grid gap-4">
            <TitleAndUnit axis={spec.y} onChange={(y) => onChange((q) => ({ ...q, y: { ...q.y, ...y } }))} />
            {spec.type === "bar" ? null : (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-label-small text-content-secondary">Scale</span>
                <Segmented<"linear" | "log">
                  label="Scale"
                  options={[
                    { value: "linear", label: "Linear" },
                    { value: "log", label: "Log" },
                  ]}
                  value={spec.y.scale}
                  onChange={(scale) => onChange((q) => ({ ...q, y: { ...q.y, scale, min: null, max: null } }))}
                />
              </div>
            )}
            <Range axis={spec.y} time={null} onChange={(y) => onChange((q) => ({ ...q, y: { ...q.y, ...y } }))} />
          </div>
        </section>
      </div>
    </div>
  );
}

// A kinetic read's time points, labeled by its time column when it has one.
function readOptions(layout: PlateLayout, table: DataTable): { row: number; label: string }[] {
  const time = layout.kind === "read" ? layout.time : null;
  return Array.from({ length: table.rows }, (_, row) => {
    const v = time?.values[row];
    const at =
      time === null || v === null || v === undefined ? "" : time.kind === "date" ? ` · ${formatDate(v, time.time)}` : ` · ${formatValue(v)}${time.unit ? ` ${time.unit}` : ""}`;
    return { row, label: `Read ${row + 1}${at}` };
  });
}

function PlateSettings({
  spec,
  table,
  layout,
  onChange,
}: {
  spec: HeatmapSpec;
  table: DataTable;
  layout: PlateLayout | null;
  onChange: (f: (s: HeatmapSpec) => HeatmapSpec) => void;
}) {
  const source = spec.plate.source;
  return (
    <div className="mt-10 grid gap-10 md:grid-cols-2">
      <section aria-labelledby="plate-heading">
        <h2 id="plate-heading" className="text-heading-xsmall">
          Plate
        </h2>
        <p className="mt-1 text-paragraph-small text-content-tertiary">
          {spec.plate.size} wells, {source.kind === "grid" ? "laid out as a grid" : source.kind === "wells" ? "one row per well" : "a column per well"}.
        </p>
        <div className="mt-4 grid gap-4">
          {source.kind === "wells" && layout?.kind === "wells" ? (
            <Field label="Color by">
              {(id) => (
                <select
                  id={id}
                  value={source.value}
                  onChange={(e) => {
                    const column = layout.values.find((c) => c.id === e.target.value);
                    if (column === undefined) return;
                    onChange((s) => ({ ...s, plate: { ...s.plate, source: { ...source, value: column.id } }, value: { ...s.value, title: column.name, unit: column.unit ?? "", min: null, max: null } }));
                  }}
                  className={inputVariants({ size: "compact" })}
                >
                  {layout.values.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} · {columnLabel(c)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          {source.kind === "read" && layout !== null ? (
            <Field label="Time point">
              {(id) => (
                <select
                  id={id}
                  value={source.row}
                  onChange={(e) => onChange((s) => ({ ...s, plate: { ...s.plate, source: { kind: "read", row: Number(e.target.value) } } }))}
                  className={inputVariants({ size: "compact" })}
                >
                  {readOptions(layout, table).map((o) => (
                    <option key={o.row} value={o.row}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
        </div>
      </section>
      <section aria-labelledby="scale-heading">
        <h2 id="scale-heading" className="text-heading-xsmall">
          Color scale
        </h2>
        <div className="mt-4 grid gap-4">
          <TitleAndUnit axis={spec.value} onChange={(value) => onChange((s) => ({ ...s, value: { ...s.value, ...value } }))} />
          <Range axis={spec.value} time={null} onChange={(value) => onChange((s) => ({ ...s, value: { ...s.value, ...value } }))} />
        </div>
      </section>
    </div>
  );
}

function ProtocolSetting({
  protocols,
  protocolId,
  onProtocol,
}: {
  protocols: readonly ProtocolChoice[];
  protocolId: ProtocolId | null;
  onProtocol: (id: ProtocolId | null) => void;
}) {
  const protocolSelect = useId();
  return (
    <section aria-labelledby="protocol-heading" className="mt-10">
      <h2 id="protocol-heading" className="text-heading-xsmall">
        Protocol
      </h2>
      <p className="mt-1 text-paragraph-small text-content-tertiary">Show this chart on a protocol&apos;s page.</p>
      <label htmlFor={protocolSelect} className="sr-only">
        Protocol
      </label>
      <select
        id={protocolSelect}
        value={protocolId ?? ""}
        onChange={(e) => onProtocol(protocols.find((p) => p.id === e.target.value)?.id ?? null)}
        className={cn(inputVariants({ size: "compact" }), "mt-3 max-w-md")}
      >
        <option value="">None</option>
        {protocols.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>
      {protocolId === null ? null : (
        <a href={protocolHref(protocolId)} className="mt-2 block text-paragraph-small text-content-accent underline-offset-2 hover:underline">
          Open the protocol
        </a>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-label-small text-content-secondary">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

function TitleAndUnit({
  axis,
  noUnit = false,
  onChange,
}: {
  axis: { title: string; unit: string };
  noUnit?: boolean;
  onChange: (v: { title?: string; unit?: string }) => void;
}) {
  const title = (
    <Field label="Title">
      {(id) => <Input id={id} size="compact" maxLength={80} value={axis.title} onChange={(e) => onChange({ title: e.target.value })} />}
    </Field>
  );
  if (noUnit) return title;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
      {title}
      <Field label="Unit">
        {(id) => <Input id={id} size="compact" maxLength={24} value={axis.unit} placeholder="none" onChange={(e) => onChange({ unit: e.target.value })} />}
      </Field>
    </div>
  );
}

// Optional bounds; blank is "fit the data". A time axis takes dates (with times when the
// column has them), read as the wall-clock time the file wrote.
function Range({
  axis,
  time,
  onChange,
}: {
  axis: { min: number | null; max: number | null };
  time: boolean | null;
  onChange: (v: { min?: number | null; max?: number | null }) => void;
}) {
  const Bound = time === null ? BoundInput : DateBoundInput;
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="From">
        {(id) => <Bound id={id} value={axis.min} withTime={time ?? false} onChange={(min) => onChange({ min })} />}
      </Field>
      <Field label="To">
        {(id) => <Bound id={id} value={axis.max} withTime={time ?? false} onChange={(max) => onChange({ max })} />}
      </Field>
    </div>
  );
}

type BoundProps = { id: string; value: number | null; withTime: boolean; onChange: (v: number | null) => void };

function BoundInput({ id, value, onChange }: BoundProps) {
  const [text, setText] = useState(value === null ? "" : String(value));
  // A bound cleared from outside (a new column, a new scale) clears the box too.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    const typed = text.trim() === "" ? null : Number(text);
    if (typed !== value) setText(value === null ? "" : String(value));
  }
  return (
    <Input
      id={id}
      size="compact"
      inputMode="decimal"
      placeholder="Fit the data"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const t = e.target.value.trim();
        if (t === "") onChange(null);
        else if (Number.isFinite(Number(t))) onChange(Number(t));
      }}
    />
  );
}

function DateBoundInput({ id, value, withTime, onChange }: BoundProps) {
  const toText = (ms: number | null) => (ms === null ? "" : new Date(ms).toISOString().slice(0, withTime ? 16 : 10));
  return (
    <Input
      id={id}
      size="compact"
      type={withTime ? "datetime-local" : "date"}
      value={toText(value)}
      onChange={(e) => {
        const t = e.target.value;
        const ms = t === "" ? null : Date.parse(withTime ? `${t}:00Z` : `${t}T00:00:00Z`);
        onChange(ms === null || Number.isNaN(ms) ? null : ms);
      }}
    />
  );
}

function SeriesRow({
  spec,
  series,
  table,
  numbers,
  ownXChoices,
  onChange,
  onRemove,
}: {
  spec: XYSpec;
  series: Series;
  table: DataTable;
  numbers: readonly DataColumn[];
  ownXChoices: readonly DataColumn[];
  onChange: (f: (s: Series) => Series) => void;
  onRemove: (() => void) | null;
}) {
  const column = findColumn(table, series.column);
  const taken = [spec.x.column, ...spec.series.map((q) => q.column)];
  const xColumn = findColumn(table, spec.x.column);
  return (
    <li className="grid gap-3">
      <div className="flex items-end gap-3">
        <Field label="Name">
          {(id) => <Input id={id} size="compact" maxLength={80} value={series.name} onChange={(e) => onChange((s) => ({ ...s, name: e.target.value }))} />}
        </Field>
        {onRemove === null ? null : (
          <Button variant="tertiary" size="compact" shape="square" className="shrink-0 text-content-secondary" onClick={onRemove}>
            <DeleteIcon />
            <span className="sr-only">Stop plotting {series.name}</span>
          </Button>
        )}
      </div>
      <div className={cn("grid gap-3", ownXChoices.length > 0 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        <Field label="Column">
          {(id) => (
            <select
              id={id}
              value={series.column}
              onChange={(e) => {
                const next = numbers.find((c) => c.id === e.target.value);
                if (next === undefined) return;
                onChange((s) => ({ ...s, column: next.id, name: s.name === column?.name ? next.name : s.name }));
              }}
              className={inputVariants({ size: "compact" })}
            >
              {numbers
                .filter((c) => c.id === series.column || !taken.includes(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {columnLabel(c)}
                  </option>
                ))}
            </select>
          )}
        </Field>
        {ownXChoices.length === 0 ? null : (
          <Field label="Along x">
            {(id) => (
              <select
                id={id}
                value={series.x ?? ""}
                onChange={(e) => onChange((s) => ({ ...s, x: ownXChoices.find((c) => c.id === e.target.value)?.id ?? null }))}
                className={inputVariants({ size: "compact" })}
              >
                <option value="">{xColumn === undefined ? "The chart's x" : `${xColumn.id} · ${columnLabel(xColumn)}`}</option>
                {ownXChoices
                  .filter((c) => c.id !== series.column && !spec.series.some((q) => q.column === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} · {columnLabel(c)}
                    </option>
                  ))}
              </select>
            )}
          </Field>
        )}
        <Field label="Error bars">
          {(id) => (
            <select
              id={id}
              value={series.error ?? ""}
              onChange={(e) => onChange((s) => ({ ...s, error: numbers.find((c) => c.id === e.target.value)?.id ?? null }))}
              className={inputVariants({ size: "compact" })}
            >
              <option value="">None</option>
              {numbers
                .filter((c) => c.id !== series.column)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    ± {c.id} · {columnLabel(c)}
                  </option>
                ))}
            </select>
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ColorPicker name={series.name} value={series.color} onChange={(color) => onChange((s) => ({ ...s, color }))} />
        {spec.type === "line" ? (
          <Segmented<Stroke>
            label={`Line for ${series.name}`}
            options={[
              { value: "solid", label: "Solid" },
              { value: "dashed", label: "Dashed" },
            ]}
            value={series.stroke}
            onChange={(stroke) => onChange((s) => ({ ...s, stroke }))}
          />
        ) : null}
      </div>
    </li>
  );
}

function ColorPicker({ name, value, onChange }: { name: string; value: SeriesColor; onChange: (c: SeriesColor) => void }) {
  return (
    <div role="radiogroup" aria-label={`Color for ${name}`} className="flex flex-wrap gap-1">
      {SERIES_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          aria-label={PALETTE[c].name}
          title={PALETTE[c].name}
          onClick={() => onChange(c)}
          className={cn(
            "flex size-11 items-center justify-center rounded-full sm:size-8",
            c === value ? "ring-2 ring-border-selected ring-inset" : "hover:bg-background-secondary",
          )}
        >
          <span className="size-4 rounded-full" style={{ background: `var(--chart-${c})` }} />
        </button>
      ))}
    </div>
  );
}

function AddSeries({ choices, onAdd }: { choices: readonly DataColumn[]; onAdd: (c: DataColumn) => void }) {
  const id = useId();
  return (
    <div className="mt-5 max-w-md">
      <label htmlFor={id} className="sr-only">
        Add a series
      </label>
      <select
        id={id}
        value=""
        onChange={(e) => {
          const c = choices.find((q) => q.id === e.target.value);
          if (c !== undefined) onAdd(c);
        }}
        className={inputVariants({ size: "compact" })}
      >
        <option value="">Add a series…</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id} · {columnLabel(c)}
          </option>
        ))}
      </select>
    </div>
  );
}

function DeleteChart({ chart, file }: { chart: SavedChart; file: ChartFile }) {
  const api = useLabApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const back = useMemo(() => (chart.protocolId === null ? fileHref(file) : protocolHref(chart.protocolId)), [chart.protocolId, file]);

  async function remove() {
    setBusy(true);
    try {
      await api.deleteChart(chart.id);
      void queryClient.invalidateQueries({ queryKey: fileChartsKey(file.sha256) });
      toast(`Deleted ${chart.title}`);
      router.push(back);
    } catch (error) {
      setBusy(false);
      toast.error(error instanceof Error ? error.message : "We couldn't delete that chart.");
    }
  }

  return (
    <div className="mt-16 border-t border-border-opaque pt-6">
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="tertiary" size="compact" className="-ml-3 text-content-secondary" onClick={() => setOpen(true)}>
          Delete chart
        </Button>
        <DialogContent title={`Delete ${chart.title}?`} aria-describedby={undefined}>
          <p className="px-4 pt-3 text-paragraph-medium text-content-secondary sm:px-6">The file stays as it is. Only the chart goes.</p>
          <DialogDock className="pt-6">
            <Button disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting" : "Delete"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </DialogDock>
        </DialogContent>
      </Dialog>
    </div>
  );
}
