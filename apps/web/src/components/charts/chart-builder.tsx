"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import {
  CHART_TYPE_NAMES,
  CHART_TYPES,
  chartHref,
  checkSpec,
  LEGEND_POSITIONS,
  MAX_SERIES,
  nextColor,
  PALETTE,
  SERIES_COLORS,
  specProblem,
  startingSpec,
  titleFromName,
  type ChartSpec,
  type ChartType,
  type LegendPosition,
  type SavedChart,
  type Series,
  type SeriesColor,
} from "@/lib/charts";
import { columnLabel, findColumn, mainTable, type DataColumn, type DataTable, type DataTables } from "@/lib/data-tables";
import type { ColumnId, LocationId, ProtocolId, Sha256 } from "@/lib/ids";
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
  const first = mode.kind === "edit" ? (state.tables.tables.find((t) => t.name === mode.chart.sheet) ?? null) : mainTable(state.tables);
  if (first === null) {
    return (
      <Shell crumbs={crumbs}>
        <Message>
          {mode.kind === "edit"
            ? `This chart was made from ${mode.chart.sheet}, which isn't in the file any more.`
            : "There's no table of numbers in this file to chart."}
        </Message>
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

function withAxisFrom(spec: ChartSpec, table: DataTable): ChartSpec {
  const only = spec.series.length === 1 ? findColumn(table, spec.series[0].column) : undefined;
  const x = findColumn(table, spec.x.column);
  return {
    ...spec,
    x: x !== undefined && isAutoTitle(spec.x.title, table) ? { ...spec.x, title: x.name, unit: x.unit ?? "" } : spec.x,
    y: only !== undefined && isAutoTitle(spec.y.title, table) ? { ...spec.y, title: only.name, unit: only.unit ?? "" } : spec.y,
  };
}

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
  const [saving, setSaving] = useState(false);
  const table = doc.tables.find((t) => t.name === draft.sheet) ?? first;
  const spec = draft.spec;
  const problem = spec === null ? "There's nothing in this table to plot yet. Pick another sheet." : (specProblem(spec) ?? checkSpec(spec, table));
  const dirty =
    saved === null ||
    JSON.stringify({ sheet: saved.sheet, title: saved.title, spec: saved.spec, protocolId: saved.protocolId }) !== JSON.stringify(draft);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const editSpec = (f: (s: ChartSpec) => ChartSpec) => setDraft((d) => (d.spec === null ? d : { ...d, spec: f(d.spec) }));

  function chooseTable(name: string) {
    const next = doc.tables.find((t) => t.name === name);
    if (next === undefined) return;
    setDraft((d) => ({ ...d, sheet: name, spec: startingSpec(next) }));
  }

  function togglePlot(column: DataColumn) {
    if (spec === null || column.kind !== "number" || column.id === spec.x.column) return;
    const plotted = spec.series.some((s) => s.column === column.id);
    if (!plotted && spec.series.length >= MAX_SERIES[spec.type]) {
      toast(spec.type === "scatter" ? "A scatter chart takes up to three series." : "A chart takes up to six series.");
      return;
    }
    editSpec((s) =>
      withAxisFrom(
        {
          ...s,
          series: plotted
            ? s.series.filter((q) => q.column !== column.id)
            : [...s.series, { column: column.id, name: column.name, color: nextColor(s.series), error: null }],
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
    const markup = chartMarkup(spec, table, draft.title.trim() || "Chart");
    try {
      if (kind === "svg") downloadSvg(markup, draft.title);
      else await downloadPng(markup, draft.title);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't make that file.");
    }
  }

  const titleId = useId();
  return (
    <>
      <ChartCrumbs file={file} title={saved?.title ?? "New chart"} />
      <div className="mx-auto grid w-full max-w-6xl gap-x-10 gap-y-10 px-4 pt-8 pb-24 sm:px-8 lg:grid-cols-[288px_minmax(0,1fr)]">
        <aside aria-label="Data" className="order-2 min-w-0 lg:sticky lg:top-6 lg:order-1 lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto lg:pr-2">
          <DataPanel
            doc={doc}
            table={table}
            spec={spec}
            onChooseTable={chooseTable}
            onTogglePlot={togglePlot}
          />
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
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            {spec === null ? (
              <span />
            ) : (
              <Segmented
                label="Chart type"
                options={CHART_TYPES.map((t) => ({ value: t, label: CHART_TYPE_NAMES[t] }))}
                value={spec.type}
                onChange={(type: ChartType) => editSpec((s) => ({ ...s, type, y: type === "bar" ? { ...s.y, scale: "linear" } : s.y }))}
              />
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
          {spec === null ? null : (
            <Settings
              spec={spec}
              table={table}
              onChange={editSpec}
              protocols={protocols}
              protocolId={draft.protocolId}
              onProtocol={(protocolId) => setDraft((d) => ({ ...d, protocolId }))}
            />
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
        {table.rows.toLocaleString("en-US")} rows. Tick a column to plot it.
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

function ColumnRow({ column, spec, onToggle }: { column: DataColumn; spec: ChartSpec | null; onToggle: () => void }) {
  const id = useId();
  const series = spec?.series.find((s) => s.column === column.id);
  const isX = spec?.x.column === column.id;
  const plottable = column.kind === "number" && !isX;
  const blanks = column.values.filter((v) => v === null).length - column.invalid;
  const meta = [
    isX ? "Along x" : column.kind === "number" ? "Numbers" : "Text",
    column.invalid > 0 ? `${column.invalid} not numbers` : null,
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
          checked={series !== undefined}
          disabled={!plottable}
          onChange={onToggle}
          className="mt-0.5 size-4 shrink-0 accent-[var(--content-primary)] disabled:opacity-40"
        />
        <span className="w-6 shrink-0 font-mono text-paragraph-xsmall leading-5 text-content-tertiary">{column.id}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label-small text-content-primary">{columnLabel(column)}</span>
          <span className="block text-paragraph-xsmall text-content-tertiary">{meta.join(" · ")}</span>
        </span>
        {series === undefined ? null : (
          <span aria-hidden className="mt-2 h-0.5 w-4 shrink-0 rounded-full" style={{ background: `var(--chart-${series.color})` }} />
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

function Settings({
  spec,
  table,
  onChange,
  protocols,
  protocolId,
  onProtocol,
}: {
  spec: ChartSpec;
  table: DataTable;
  onChange: (f: (s: ChartSpec) => ChartSpec) => void;
  protocols: readonly ProtocolChoice[];
  protocolId: ProtocolId | null;
  onProtocol: (id: ProtocolId | null) => void;
}) {
  const numbers = table.columns.filter((c) => c.kind === "number");
  const xChoices = spec.type === "bar" ? table.columns : numbers;
  const unplotted = numbers.filter((c) => c.id !== spec.x.column && !spec.series.some((s) => s.column === c.id));
  const editSeries = (column: ColumnId, f: (s: Series) => Series) =>
    onChange((s) => ({ ...s, series: s.series.map((q) => (q.column === column ? f(q) : q)) }));
  const protocolSelect = useId();

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
              series={s}
              table={table}
              numbers={numbers}
              taken={[spec.x.column, ...spec.series.map((q) => q.column)]}
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
                withAxisFrom({ ...q, series: [...q.series, { column: c.id, name: c.name, color: nextColor(q.series), error: null }] }, table),
              )
            }
          />
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
                      withAxisFrom({ ...q, x: { ...q.x, column: column.id, min: null, max: null }, series: q.series.filter((x) => x.column !== column.id) }, table),
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
            <TitleAndUnit axis={spec.x} onChange={(x) => onChange((q) => ({ ...q, x: { ...q.x, ...x } }))} />
            {spec.type === "bar" ? null : <Range axis={spec.x} onChange={(x) => onChange((q) => ({ ...q, x: { ...q.x, ...x } }))} />}
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
            <Range axis={spec.y} onChange={(y) => onChange((q) => ({ ...q, y: { ...q.y, ...y } }))} />
          </div>
        </section>
      </div>

      <section aria-labelledby="protocol-heading">
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
    </div>
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

function TitleAndUnit({ axis, onChange }: { axis: { title: string; unit: string }; onChange: (v: { title?: string; unit?: string }) => void }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
      <Field label="Title">
        {(id) => <Input id={id} size="compact" maxLength={80} value={axis.title} onChange={(e) => onChange({ title: e.target.value })} />}
      </Field>
      <Field label="Unit">
        {(id) => <Input id={id} size="compact" maxLength={24} value={axis.unit} placeholder="none" onChange={(e) => onChange({ unit: e.target.value })} />}
      </Field>
    </div>
  );
}

// Optional bounds; blank is "fit the data".
function Range({ axis, onChange }: { axis: { min: number | null; max: number | null }; onChange: (v: { min?: number | null; max?: number | null }) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="From">
        {(id) => <BoundInput id={id} value={axis.min} onChange={(min) => onChange({ min })} />}
      </Field>
      <Field label="To">
        {(id) => <BoundInput id={id} value={axis.max} onChange={(max) => onChange({ max })} />}
      </Field>
    </div>
  );
}

function BoundInput({ id, value, onChange }: { id: string; value: number | null; onChange: (v: number | null) => void }) {
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

function SeriesRow({
  series,
  table,
  numbers,
  taken,
  onChange,
  onRemove,
}: {
  series: Series;
  table: DataTable;
  numbers: readonly DataColumn[];
  taken: readonly ColumnId[];
  onChange: (f: (s: Series) => Series) => void;
  onRemove: (() => void) | null;
}) {
  const column = findColumn(table, series.column);
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
      <div className="grid gap-3 sm:grid-cols-2">
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
      <ColorPicker name={series.name} value={series.color} onChange={(color) => onChange((s) => ({ ...s, color }))} />
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
