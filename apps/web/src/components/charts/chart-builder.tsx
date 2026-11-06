"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { labelText, rename, type LabelTarget } from "@/lib/chart-edits";
import { chartWarnings, describeChart, startFor, startingChart, switched } from "@/lib/chart-guide";
import {
  chartHref,
  chartTrouble,
  checkSpec,
  repairSpec,
  specProblem,
  titleFromName,
  type ChartSpec,
  type ChartType,
  type HeatmapSpec,
  type SavedChart,
  type XYSpec,
} from "@/lib/charts";
import { mainTable, type DataTable, type DataTables } from "@/lib/data-tables";
import type { LocationId, ProtocolId, Sha256 } from "@/lib/ids";
import { protocolHref } from "@/lib/protocols";
import { AlertIcon, ChevronDownIcon } from "../icons/base-web";
import { DownloadIcon, PencilIcon, RedoIcon, UndoIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { Breadcrumbs } from "../ui/breadcrumbs";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDock } from "../ui/dialog";
import { menuItem, menuSurface } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { chartMarkup, downloadPng, downloadSvg } from "./chart-export";
import { ChartFigure, type FigureEdit } from "./chart-figure";
import { ChartPanel, SeriesEditor, type PanelEdit } from "./chart-panel";
import { ChartQuestion } from "./chart-question";
import { fileChartsKey } from "./file-charts";
import { useHistory } from "./use-history";

const POLL_MS = 2_000;

export const tableKey = (sha: Sha256) => ["data-table", sha] as const;

export type ChartFile = { locationId: LocationId | null; sha256: Sha256; name: string };
export type ProtocolChoice = { id: ProtocolId; title: string };
export type BuilderMode = { kind: "create"; protocolId: ProtocolId | null } | { kind: "edit"; chart: SavedChart };

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
// What undo steps through: the chart, and the x/y chart kept while a plate is shown (and the
// other way round), so switching back finds it.
type Doc = { draft: Draft; other: ChartSpec | null };

const MARK_WORD = { line: "line", bar: "bar", scatter: "dot" } satisfies Record<XYSpec["type"], string>;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");

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
  const history = useHistory<Doc>(() => ({
    draft:
      mode.kind === "edit"
        ? { sheet: mode.chart.sheet, title: mode.chart.title, spec: mode.chart.spec, protocolId: mode.chart.protocolId }
        : { sheet: first.name, title: titleFromName(file.name), spec: startingChart(first), protocolId: mode.protocolId },
    other: null,
  }));
  const { draft, other } = history.value;
  const [saving, setSaving] = useState(false);
  const table = doc.tables.find((t) => t.name === draft.sheet) ?? first;
  const spec = draft.spec;
  const problem = spec === null ? "There's nothing in this sheet to draw. Pick another sheet." : (specProblem(spec) ?? checkSpec(spec, table));
  const dirty =
    saved === null ||
    JSON.stringify({ sheet: saved.sheet, title: saved.title, spec: saved.spec, protocolId: saved.protocolId }) !== JSON.stringify(draft);
  // A saved chart whose file was read again and no longer fits says why, until it's fixed.
  const broken = saved !== null && !dirty ? chartTrouble(saved, doc.tables) : null;
  const sentence = useMemo(() => (spec === null || problem !== null ? "" : describeChart(spec, table)), [spec, problem, table]);
  const warnings = useMemo(() => (spec === null || problem !== null ? [] : chartWarnings(spec, table)), [spec, problem, table]);

  useEffect(() => {
    if (!dirty || asking) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, asking]);

  const changeDraft = (f: (d: Draft) => Draft, group?: string) => history.change((h) => ({ ...h, draft: f(h.draft) }), group);
  const editSpec = (f: (s: ChartSpec) => ChartSpec, group?: string) => changeDraft((d) => (d.spec === null ? d : { ...d, spec: f(d.spec) }), group);
  const edit: PanelEdit = {
    xy: (f: (s: XYSpec) => XYSpec, group?: string) => editSpec((s) => (s.type === "heatmap" ? s : f(s)), group),
    plate: (f: (s: HeatmapSpec) => HeatmapSpec, group?: string) => editSpec((s) => (s.type === "heatmap" ? f(s) : s), group),
    type: (type: ChartType) =>
      history.change((h) => {
        const s = h.draft.spec;
        if (s === null || s.type === type) return h;
        const next = switched(s, type, table, h.other);
        if (next === null) return h;
        const crossing = (s.type === "heatmap") !== (type === "heatmap");
        return { draft: { ...h.draft, spec: next }, other: crossing ? s : h.other };
      }),
    sheet: (name: string) => {
      const next = doc.tables.find((t) => t.name === name);
      if (next === undefined) return;
      history.change((h) => ({ draft: { ...h.draft, sheet: name, spec: startingChart(next) }, other: null }));
    },
    protocol: (protocolId: ProtocolId | null) => changeDraft((d) => ({ ...d, protocolId })),
  };

  const figureEdit: FigureEdit = {
    rename: (target: LabelTarget, text: string) => editSpec((s) => rename(s, table, target, text)),
    textOf: (target: LabelTarget) => (spec === null ? "" : labelText(spec, target)),
    seriesEditor: (column, close) =>
      spec === null || spec.type === "heatmap" ? null : <SeriesEditor spec={spec} column={column} table={table} edit={edit} onDone={close} />,
  };

  // The question's answer starts the chart; it isn't a step to undo back past.
  function answer(type: ChartType) {
    const start = startFor(table, type);
    history.settle({ draft: { ...draft, sheet: table.name, spec: start }, other: null });
    setAsking(false);
  }

  function fix() {
    const mended = spec === null ? null : repairSpec(spec, table);
    changeDraft((d) => ({ ...d, sheet: table.name, spec: mended ?? startingChart(table) }));
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
      history.settle({
        draft: { sheet: outcome.chart.sheet, title: outcome.chart.title, spec: outcome.chart.spec, protocolId: outcome.chart.protocolId },
        other,
      });
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

  const crumbTitle = saved?.title ?? "New chart";
  if (asking) {
    return (
      <>
        <TopBar file={file} title={crumbTitle} />
        <ChartQuestion doc={doc} table={table} onSheet={(name) => edit.sheet(name)} onPick={answer} />
      </>
    );
  }

  const canExport = spec !== null && problem === null;
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
        <ExportMenu disabled={!canExport} onExport={(kind) => void exportAs(kind)} />
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
                label={draft.title || "Chart"}
                edit={figureEdit}
                hint={
                  <>
                    <PencilIcon className="size-3.5" />
                    {spec.type === "heatmap" ? "Click the scale's title to rename it." : `Click a title, a name or a ${MARK_WORD[spec.type]} to change it.`}
                  </>
                }
              />
            )}
          </div>
        </div>
        <aside aria-label="Chart settings" className="min-w-0">
          {spec === null ? (
            <SheetOnly doc={doc} table={table} onSheet={edit.sheet} />
          ) : (
            <ChartPanel
              doc={doc}
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
    </>
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

function ExportMenu({ disabled, onExport }: { disabled: boolean; onExport: (kind: "svg" | "png") => void }) {
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
        <DropdownMenu.Content align="end" sideOffset={6} className={cn(menuSurface, "w-72")}>
          <DropdownMenu.Item className={cn(menuItem, "items-start py-2")} onSelect={() => onExport("png")}>
            <span>
              <span className="block text-label-medium">Picture for slides</span>
              <span className="block text-paragraph-small text-content-tertiary">PNG, for slides and documents</span>
            </span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={cn(menuItem, "items-start py-2")} onSelect={() => onExport("svg")}>
            <span>
              <span className="block text-label-medium">Picture for a paper</span>
              <span className="block text-paragraph-small text-content-tertiary">SVG, sharp at any size</span>
            </span>
          </DropdownMenu.Item>
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
