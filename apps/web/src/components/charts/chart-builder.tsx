"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { labelText, rename, type LabelTarget } from "@/lib/chart-edits";
import { chartWarnings, describeChart, startChart, suggestionsFor, switchKind } from "@/lib/chart-guide";
import { chartHref, chartTrouble, checkSpec, isSummary, isXY, repairSpec, specProblem, titleFromName, type ChartSpec, type HeatmapSpec, type SavedChart, type XYSpec } from "@/lib/charts";
import { mainTable, type DataTable, type DataTables } from "@/lib/data-tables";
import type { LocationId, ProtocolId, Sha256 } from "@/lib/ids";
import { describeLayout, layoutChoices, layoutFromFile, type SavedLayout } from "@/lib/layouts";
import { plateLayout } from "@/lib/plates";
import { protocolHref } from "@/lib/protocols";
import { kindOf, type ChartData, type ChartKind, type PlateMap } from "@/lib/summary-guide";
import { AlertIcon, CheckIcon, ChevronDownIcon } from "../icons/base-web";
import { DownloadIcon, PencilIcon, RedoIcon, UndoIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { Breadcrumbs } from "../ui/breadcrumbs";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDock } from "../ui/dialog";
import { menuItem, menuSurface } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { chartCsv, chartMarkup, downloadPdf, downloadPng, downloadSvg, EXPORT_SIZE_KEYS, EXPORT_SIZES, fileName, saveText, type ExportSize } from "./chart-export";
import { ChartFigure, type FigureEdit } from "./chart-figure";
import { ChartPanel, SeriesEditor, type PanelEdit } from "./chart-panel";
import { ChartQuestion } from "./chart-question";
import { fileChartsKey } from "./file-charts";
import { LayoutPainter } from "./layout-painter";
import { useHistory } from "./use-history";

const POLL_MS = 2_000;

export const tableKey = (sha: Sha256) => ["data-table", sha] as const;

export type ChartFile = { locationId: LocationId | null; sha256: Sha256; name: string };
export type ProtocolChoice = { id: ProtocolId; title: string };
export type BuilderMode = { kind: "create"; protocolId: ProtocolId | null } | { kind: "edit"; chart: SavedChart; provenance?: Provenance };

export function fileHref(file: ChartFile): string {
  return `/?${new URLSearchParams({ q: file.name, open: file.sha256 })}`;
}

// The chart builder (decisions.md, "charts for a first-year student"). A new chart asks one
// question, what to show, then opens drawn, with the columns already picked; the chart is the
// main thing on screen, its words and marks edit in place, and one panel holds the rest. It
// opens once the worker has the file's full table, asking for it when the file was indexed
// before charts existed.
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
  const crumbs = <TopBar file={file} title={title} />;

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

// The page's top bar: where the chart comes from, and its actions once there are any.
function TopBar({ file, title, children }: { file: ChartFile; title: string; children?: ReactNode }) {
  return (
    <div className="border-b border-border-opaque">
      <div className="mx-auto flex min-h-14 w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-8">
        <div className="min-w-0 flex-1">
          <Breadcrumbs items={[...(file.locationId === null ? [] : [{ label: file.name, href: fileHref(file) }]), { label: title, href: "#" }]} />
        </div>
        {children === undefined ? null : <div className="flex items-center gap-1">{children}</div>}
      </div>
    </div>
  );
}

type Draft = { sheet: string; title: string; spec: ChartSpec | null; protocolId: ProtocolId | null };
// What undo steps through: the chart, the chart kept while another kind is shown (so switching
// back finds it), and the plate's layout as it's marked.
type Doc = { draft: Draft; other: ChartSpec | null; layout: PlateMap | null };

const MARK_WORD = { line: "line", bar: "bar", scatter: "dot" } satisfies Record<XYSpec["type"], string>;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

export const layoutsKey = ["sample-layouts"] as const;

// The layout a chart starts with: the one it saved, else the one the export carries.
function startingLayout(doc: DataTables, table: DataTable, spec: ChartSpec | null): PlateMap | null {
  if (spec !== null && isSummary(spec) && spec.source.kind === "plate") return { layout: spec.source.layout, layoutId: spec.source.layoutId, from: "" };
  const found = layoutFromFile(doc, table);
  return found === null ? null : { ...found, layoutId: null };
}

function withLayout(spec: ChartSpec | null, map: PlateMap): ChartSpec | null {
  if (spec === null || !isSummary(spec) || spec.source.kind !== "plate") return spec;
  return { ...spec, source: { ...spec.source, layout: map.layout, layoutId: map.layoutId } };
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
  // A new chart starts on its question; a saved one opens drawn.
  const [asking, setAsking] = useState(mode.kind === "create");
  const [painting, setPainting] = useState(false);
  const history = useHistory<Doc>(() => {
    const spec = mode.kind === "edit" ? mode.chart.spec : null;
    const layout = startingLayout(doc, first, spec);
    const data: ChartData = { table: first, tables: doc.tables, layout };
    return {
      draft:
        mode.kind === "edit"
          ? { sheet: mode.chart.sheet, title: mode.chart.title, spec: mode.chart.spec, protocolId: mode.chart.protocolId }
          : { sheet: first.name, title: titleFromName(file.name), spec: startChart(data), protocolId: mode.protocolId },
      other: null,
      layout,
    };
  });
  const { draft, other, layout } = history.value;
  const [saving, setSaving] = useState(false);
  const table = doc.tables.find((t) => t.name === draft.sheet) ?? first;
  const data = useMemo<ChartData>(() => ({ table, tables: doc.tables, layout }), [table, doc.tables, layout]);
  const plate = plateLayout(table);
  const markable = plate !== null && plate.kind !== "read";
  const layoutsQuery = useQuery({ queryKey: layoutsKey, queryFn: ({ signal }) => api.layouts(signal), enabled: markable });
  const savedLayouts = useMemo(() => (plate === null ? [] : layoutChoices(layoutsQuery.data ?? [], plate.size, draft.protocolId)), [layoutsQuery.data, plate, draft.protocolId]);
  const spec = draft.spec;
  const problem = spec === null ? "There's nothing in this sheet to draw. Pick another sheet." : (specProblem(spec) ?? checkSpec(spec, table, doc.tables));
  const dirty =
    saved === null ||
    JSON.stringify({ sheet: saved.sheet, title: saved.title, spec: saved.spec, protocolId: saved.protocolId }) !== JSON.stringify(draft);
  // A saved chart whose file was read again and no longer fits says why, until it's fixed.
  const broken = saved !== null && !dirty ? chartTrouble(saved, doc.tables) : null;
  const sentence = useMemo(() => (spec === null || problem !== null ? "" : describeChart(spec, table, doc.tables)), [spec, problem, table, doc.tables]);
  const warnings = useMemo(() => (spec === null || problem !== null ? [] : chartWarnings(spec, table, doc.tables)), [spec, problem, table, doc.tables]);
  const [size, setSize] = useState<ExportSize>("column");

  useEffect(() => {
    if (!dirty || asking) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, asking]);

  const changeDraft = (f: (d: Draft) => Draft, group?: string) => history.change((h) => ({ ...h, draft: f(h.draft) }), group);
  const editSpec = (f: (s: ChartSpec) => ChartSpec, group?: string) => changeDraft((d) => (d.spec === null ? d : { ...d, spec: f(d.spec) }), group);

  // A layout marked or picked: a chart of repeats follows it, and a plate picture moves on to
  // what the layout now suggests (the student marked the wells to get there).
  function applyLayout(map: PlateMap) {
    history.change((h) => {
      const nextData: ChartData = { table, tables: doc.tables, layout: map };
      const s = h.draft.spec;
      if (s !== null && isSummary(s) && s.source.kind === "plate") return { ...h, layout: map, draft: { ...h.draft, spec: withLayout(s, map) } };
      const suggested = suggestionsFor(nextData).find((x) => x.kind !== "heatmap");
      const next = suggested === undefined ? null : startChart(nextData, suggested.kind);
      if (next === null || asking) return { ...h, layout: map };
      return { layout: map, other: s, draft: { ...h.draft, spec: next } };
    });
  }

  const edit: PanelEdit = {
    xy: (f: (s: XYSpec) => XYSpec, group?: string) => editSpec((s) => (isXY(s) ? f(s) : s), group),
    plate: (f: (s: HeatmapSpec) => HeatmapSpec, group?: string) => editSpec((s) => (s.type === "heatmap" ? f(s) : s), group),
    summary: (f, group) => editSpec((s) => (isSummary(s) || s.type === "histogram" ? f(s) : s), group),
    kind: (kind: ChartKind) =>
      history.change((h) => {
        const s = h.draft.spec;
        if (s === null || kindOf(s) === kind) return h;
        const next = switchKind(s, kind, data, h.other);
        if (next === null) return h;
        return { ...h, draft: { ...h.draft, spec: next }, other: s };
      }),
    sheet: (name: string) => {
      const next = doc.tables.find((t) => t.name === name);
      if (next === undefined) return;
      const nextLayout = startingLayout(doc, next, null);
      history.change(() => ({ draft: { ...draft, sheet: name, spec: startChart({ table: next, tables: doc.tables, layout: nextLayout }) }, other: null, layout: nextLayout }));
    },
    protocol: (protocolId: ProtocolId | null) => changeDraft((d) => ({ ...d, protocolId })),
    markWells: markable ? () => setPainting(true) : null,
  };

  const figureEdit: FigureEdit = {
    rename: (target: LabelTarget, text: string) => editSpec((s) => rename(s, table, target, text)),
    textOf: (target: LabelTarget) => (spec === null ? "" : labelText(spec, target)),
    seriesEditor: (column, close) => (spec === null || !isXY(spec) ? null : <SeriesEditor spec={spec} column={column} table={table} edit={edit} onDone={close} />),
  };

  // The question's answer starts the chart; it isn't a step to undo back past.
  function answer(kind: ChartKind) {
    history.settle({ draft: { ...draft, sheet: table.name, spec: startChart(data, kind) }, other: null, layout });
    setAsking(false);
  }

  function fix() {
    const mended = spec === null ? null : repairSpec(spec, table);
    changeDraft((d) => ({ ...d, sheet: table.name, spec: mended ?? startChart(data) }));
  }

  async function save() {
    if (spec === null || problem !== null || saving) return;
    const title = draft.title.trim();
    if (title === "") {
      toast.error("Give the chart a title. Click it above the chart to type one.");
      return;
    }
    setSaving(true);
    try {
      const fields = { sheet: draft.sheet, title, spec, protocolId: draft.protocolId };
      if (saved === null) {
        const chart = await api.createChart({ sha256: file.sha256, ...fields });
        setSaved(chart);
        void queryClient.invalidateQueries({ queryKey: fileChartsKey(file.sha256) });
        toast.success("Chart saved", { description: `Find it again by opening ${file.name}.` });
        router.replace(chartHref(chart.id));
        return;
      }
      const outcome = await api.saveChart(saved.id, { ...fields, basedOn: saved.updatedAt });
      if (outcome.kind === "stale") {
        toast.error("Someone saved this chart since you opened it. Reload to see theirs.");
        return;
      }
      setSaved(outcome.chart);
      history.settle({
        draft: { sheet: outcome.chart.sheet, title: outcome.chart.title, spec: outcome.chart.spec, protocolId: outcome.chart.protocolId },
        other,
        layout,
      });
      void queryClient.invalidateQueries({ queryKey: fileChartsKey(file.sha256) });
      toast.success("Chart saved", { description: `Find it again by opening ${file.name}.` });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save that chart.");
    } finally {
      setSaving(false);
    }
  }

  const provenance = useMemo(() => provenanceLines({ file, sheet: draft.sheet, spec, protocols, protocolId: draft.protocolId, made: mode.kind === "edit" ? mode.provenance : undefined }), [file, draft.sheet, spec, protocols, draft.protocolId, mode]);

  async function exportAs(kind: ExportKind) {
    if (spec === null || problem !== null) return;
    const title = draft.title.trim() || "Chart";
    try {
      if (kind === "csv") {
        saveText(chartCsv(spec, table, title, provenance.map((p) => p.text), doc.tables), fileName(title, "csv"), "text/csv");
        return;
      }
      const figure = chartMarkup(spec, table, title, size, doc.tables);
      if (kind === "svg") downloadSvg(figure, title);
      else if (kind === "pdf") await downloadPdf(figure, title);
      else await downloadPng(figure, title);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't make that file.");
    }
  }

  // ⌘Z and ⇧⌘Z (Ctrl on Windows) step through the chart's changes; a text field keeps its own.
  // ⌘S saves from anywhere.
  const keys = useRef({ undo: history.undo, redo: history.redo, save });
  useEffect(() => {
    keys.current = { undo: history.undo, redo: history.redo, save };
  });
  useEffect(() => {
    if (asking) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void keys.current.save();
        return;
      }
      if (isTyping(e.target)) return;
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) keys.current.redo();
        else keys.current.undo();
      } else if (key === "y" && e.ctrlKey) {
        e.preventDefault();
        keys.current.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking]);

  const painter = markable ? (
    <LayoutPainter
      key={painting ? "open" : "closed"}
      open={painting}
      onClose={() => setPainting(false)}
      table={table}
      sha256={file.sha256}
      start={layout}
      protocols={protocols}
      protocolId={draft.protocolId}
      saved={savedLayouts}
      onDone={(map) => {
        setPainting(false);
        void queryClient.invalidateQueries({ queryKey: layoutsKey });
        applyLayout(map);
      }}
    />
  ) : null;

  const pickSaved = (s: SavedLayout) => applyLayout({ layout: s.layout, layoutId: s.id, from: `the layout saved as ${s.name}` });

  const crumbTitle = saved?.title ?? "New chart";
  if (asking) {
    return (
      <>
        <TopBar file={file} title={crumbTitle} />
        <ChartQuestion doc={doc} data={data} saved={savedLayouts} onSheet={(name) => edit.sheet(name)} onPick={answer} onMark={() => setPainting(true)} onUseLayout={pickSaved} />
        {painter}
      </>
    );
  }

  const canExport = spec !== null && problem === null;
  const hint =
    spec === null ? null : spec.type === "heatmap" ? (
      "Point at a well to read it. Click the scale's title to rename it."
    ) : isXY(spec) ? (
      `Click a title, a name or a ${MARK_WORD[spec.type]} to change it.`
    ) : (
      "Point at a mark to read it. Click an axis title to rename it."
    );
  return (
    <>
      <TopBar file={file} title={crumbTitle}>
        <Button variant="tertiary" size="compact" shape="square" disabled={!history.canUndo} onClick={history.undo} title="Undo (⌘Z)" className="text-content-secondary">
          <UndoIcon className="size-5" />
          <span className="sr-only">Undo</span>
        </Button>
        <Button variant="tertiary" size="compact" shape="square" disabled={!history.canRedo} onClick={history.redo} title="Redo (⇧⌘Z)" className="text-content-secondary">
          <RedoIcon className="size-5" />
          <span className="sr-only">Redo</span>
        </Button>
        <ExportMenu disabled={!canExport} size={size} onSize={setSize} onExport={(kind) => void exportAs(kind)} />
        <Button size="compact" className="ml-1 min-w-20" disabled={saving || problem !== null || !dirty} onClick={() => void save()}>
          {saving ? "Saving" : saved !== null && !dirty ? "Saved" : "Save"}
        </Button>
      </TopBar>
      <div className="mx-auto grid w-full max-w-7xl gap-x-12 gap-y-10 px-4 pt-6 pb-24 sm:px-8 sm:pt-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* The chart stays in view while the panel beside it scrolls with the page. */}
        <div className="min-w-0 lg:sticky lg:top-6 lg:self-start">
          <ChartTitle value={draft.title} onChange={(title) => changeDraft((d) => ({ ...d, title }), "title")} />
          {sentence === "" ? null : (
            <p className="mt-2 max-w-3xl text-paragraph-medium text-content-secondary" aria-live="polite">
              {sentence}
            </p>
          )}
          {warnings.length === 0 ? null : (
            <ul className="mt-3 grid gap-1.5">
              {warnings.map((w) => (
                <li key={w} className="flex items-start gap-2 text-paragraph-small text-content-secondary">
                  <AlertIcon className="mt-0.5 size-4 shrink-0 text-content-tertiary" />
                  {w}
                </li>
              ))}
            </ul>
          )}
          {broken === null ? null : (
            <div role="alert" className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-control bg-background-secondary px-4 py-3">
              <p className="min-w-0 flex-1 text-paragraph-small text-content-secondary">{broken}</p>
              <Button size="compact" variant="secondary" onClick={fix}>
                Fix the chart
              </Button>
            </div>
          )}
          <div className="mt-6">
            {spec === null || problem !== null ? (
              <div className="flex min-h-64 items-center justify-center rounded-card bg-background-secondary px-6 text-center">
                <p className="max-w-sm text-paragraph-medium text-content-secondary">{problem}</p>
              </div>
            ) : (
              <ChartFigure
                spec={spec}
                table={table}
                tables={doc.tables}
                label={draft.title || "Chart"}
                edit={figureEdit}
                hint={
                  hint === null ? undefined : (
                    <>
                      <PencilIcon className="size-3.5" />
                      {hint}
                    </>
                  )
                }
              />
            )}
          </div>
          {saved === null ? null : <MadeFrom lines={provenance} />}
        </div>
        <aside aria-label="Chart settings" className="min-w-0">
          {spec === null ? (
            <SheetOnly doc={doc} table={table} onSheet={edit.sheet} />
          ) : (
            <ChartPanel
              doc={doc}
              data={data}
              table={table}
              spec={spec}
              other={other}
              protocols={protocols}
              protocolId={draft.protocolId}
              edit={edit}
              footer={saved === null ? undefined : <DeleteChart chart={saved} file={file} />}
            />
          )}
        </aside>
      </div>
      {painter}
    </>
  );
}

export type Provenance = { protocolVersion: { version: number; title: string } | null; layoutName: string | null };
type MadeLine = { text: string; href: string | null; link: string | null };

// "Made from …": the file, the sheet, the wells and the layout they were read by, and the
// protocol version the chart was saved on, each with its link.
function provenanceLines({
  file,
  sheet,
  spec,
  protocols,
  protocolId,
  made,
}: {
  file: ChartFile;
  sheet: string;
  spec: ChartSpec | null;
  protocols: readonly ProtocolChoice[];
  protocolId: ProtocolId | null;
  made: Provenance | undefined;
}): MadeLine[] {
  const out: MadeLine[] = [{ text: `Made from ${file.name}, sheet ${sheet}`, href: file.locationId === null ? null : fileHref(file), link: file.name }];
  if (spec !== null && isSummary(spec) && spec.source.kind === "plate") {
    const wells = spec.source.layout.groups.flatMap((g) => g.wells);
    const range = wells.length === 0 ? "" : `${wells.length} wells (${wells[0]} to ${wells.at(-1)})`;
    const name = made?.layoutName ?? null;
    out.push({ text: `${range} read by ${name === null ? "the layout marked for this chart" : `the layout “${name}”`}: ${describeLayout(spec.source.layout)}`, href: null, link: null });
  }
  const protocol = protocols.find((p) => p.id === protocolId);
  if (protocol !== undefined) {
    const v = made?.protocolVersion;
    out.push({ text: `On ${protocol.title}${v === null || v === undefined ? "" : `, version ${v.version}`}`, href: protocolHref(protocol.id), link: protocol.title });
  }
  return out;
}

function MadeFrom({ lines }: { lines: readonly MadeLine[] }) {
  return (
    <section aria-label="Made from" className="mt-6 border-t border-border-opaque pt-4">
      <ul className="grid gap-1 text-paragraph-small text-content-secondary">
        {lines.map((l) => {
          if (l.href === null || l.link === null) return <li key={l.text}>{l.text}.</li>;
          const [before, after] = [l.text.slice(0, l.text.indexOf(l.link)), l.text.slice(l.text.indexOf(l.link) + l.link.length)];
          return (
            <li key={l.text}>
              {before}
              <a href={l.href} className="text-content-accent underline-offset-2 hover:underline">
                {l.link}
              </a>
              {after}.
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// A sheet with nothing to draw still lets you move to another.
function SheetOnly({ doc, table, onSheet }: { doc: DataTables; table: DataTable; onSheet: (name: string) => void }) {
  const id = useId();
  if (doc.tables.length < 2) return null;
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-label-medium text-content-primary">
        Sheet
      </label>
      <select id={id} value={table.name} onChange={(e) => onSheet(e.target.value)} className="min-h-11 rounded-control border border-border-opaque bg-background-secondary px-3 text-paragraph-small sm:min-h-8">
        {doc.tables.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// The chart's title, edited where it sits; a pencil says so on hover.
function ChartTitle({ value, onChange }: { value: string; onChange: (title: string) => void }) {
  const id = useId();
  return (
    <div className="group/title relative">
      <label htmlFor={id} className="sr-only">
        Chart title
      </label>
      <input
        id={id}
        value={value}
        maxLength={200}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Name your chart"
        className="-mx-2 w-[calc(100%+16px)] rounded-control bg-transparent py-1 pr-10 pl-2 text-heading-small text-content-primary placeholder:text-content-tertiary hover:bg-background-secondary focus:bg-background-secondary focus-visible:outline-none sm:text-heading-medium"
      />
      <PencilIcon className="pointer-events-none absolute top-1/2 right-1 size-5 -translate-y-1/2 text-content-tertiary opacity-0 transition-opacity duration-150 group-hover/title:opacity-100 group-focus-within/title:opacity-0" />
    </div>
  );
}

type ExportKind = "pdf" | "svg" | "png" | "csv";

// Download: the figure's size first, then the file. Print sizes are laid out for a journal's
// column with its type at 7 pt; slides at 960 by 560.
function ExportMenu({ disabled, size, onSize, onExport }: { disabled: boolean; size: ExportSize; onSize: (size: ExportSize) => void; onExport: (kind: ExportKind) => void }) {
  const print = size !== "slides";
  const item = (kind: ExportKind, title: string, help: string) => (
    <DropdownMenu.Item className={cn(menuItem, "items-start py-2")} onSelect={() => onExport(kind)}>
      <span>
        <span className="block text-label-medium">{title}</span>
        <span className="block text-paragraph-small text-content-tertiary">{help}</span>
      </span>
    </DropdownMenu.Item>
  );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <Button variant="tertiary" size="compact" className="gap-1.5 text-content-secondary">
          <DownloadIcon className="size-5" />
          <span className="hidden sm:inline">Download</span>
          <span className="sr-only sm:hidden">Download</span>
          <ChevronDownIcon className="-mr-1 hidden size-4 sm:block" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={cn(menuSurface, "w-80")}>
          <p className="px-3 pt-2 pb-1 text-paragraph-xsmall text-content-tertiary">On white, with the title, and the test or fit written under the chart. Type prints at 7 pt.</p>
          <DropdownMenu.Label className="px-3 pt-2 pb-1 text-paragraph-xsmall text-content-tertiary">Size</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={size} onValueChange={(v) => onSize(v === "double" ? "double" : v === "slides" ? "slides" : "column")}>
            {EXPORT_SIZE_KEYS.map((key) => (
              <DropdownMenu.RadioItem key={key} value={key} onSelect={(e) => e.preventDefault()} className={cn(menuItem, "gap-2")}>
                <span className="flex size-4 items-center justify-center">
                  <DropdownMenu.ItemIndicator>
                    <CheckIcon className="size-4" />
                  </DropdownMenu.ItemIndicator>
                </span>
                {EXPORT_SIZES[key].label}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-border-opaque" />
          {item("pdf", "PDF", print ? `For a paper, ${EXPORT_SIZES[size].short} wide, sharp at any zoom` : "For slides or a handout")}
          {item("svg", "SVG", "To edit in Illustrator or Inkscape, sharp at any size")}
          {item("png", "PNG picture", print ? `${EXPORT_SIZES[size].short} at 300 dpi` : "For slides, at twice screen size")}
          <DropdownMenu.Separator className="my-1 h-px bg-border-opaque" />
          {item("csv", "The numbers behind it (CSV)", "Means, spreads, n, the test, the fit and your samples, unrounded")}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
    <div className="grid gap-2">
      <div>
        <p className="text-label-small text-content-primary">Delete this chart</p>
        <p className="text-paragraph-small text-content-tertiary">The file stays as it is. Only the chart goes.</p>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="negative" size="compact" className="w-max" onClick={() => setOpen(true)}>
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
