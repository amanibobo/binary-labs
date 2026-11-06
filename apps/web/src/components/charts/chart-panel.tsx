"use client";
import { Popover } from "radix-ui";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { addSeries, editSeries, removeSeries, restyle, setBottom, setErrorBars, spreadsFor } from "@/lib/chart-edits";
import { formatValue } from "@/lib/chart-geometry";
import { bottomChoices, choicesFor, columnKind, columnSample, measureChoices, switchProblem } from "@/lib/chart-guide";
import {
  LEGEND_POSITIONS,
  MAX_SERIES,
  PALETTE,
  SERIES_COLORS,
  type ChartSpec,
  type ChartType,
  type HeatmapSpec,
  type LegendPosition,
  type Series,
  type Stroke,
  type XYSpec,
} from "@/lib/charts";
import { axisColumns, columnLabel, findColumn, formatDate, isSpreadColumn, numberColumns, type DataColumn, type DataTable, type DataTables } from "@/lib/data-tables";
import type { ColumnId, ProtocolId } from "@/lib/ids";
import { plateLayout, rowLetter, wellName, type PlateLayout } from "@/lib/plates";
import { protocolHref } from "@/lib/protocols";
import { CheckIcon, ChevronDownIcon, DeleteIcon, PlusIcon, SearchIcon } from "../icons/base-web";
import { Button } from "../ui/button";
import { Dialog, DialogContent } from "../ui/dialog";
import { Input, inputVariants } from "../ui/field";
import { menuSurface } from "../ui/menu";
import { ChartKindGlyph } from "./chart-thumb";
import type { ProtocolChoice } from "./chart-builder";

// The builder's one panel beside the chart: the kind of chart, what runs along the bottom, what
// was measured and whether to show how much repeats vary. Everything a first chart rarely needs
// waits under More options, each with a line of everyday words.

export type PanelEdit = {
  xy: (f: (s: XYSpec) => XYSpec, group?: string) => void;
  plate: (f: (s: HeatmapSpec) => HeatmapSpec, group?: string) => void;
  type: (type: ChartType) => void;
  sheet: (name: string) => void;
  protocol: (id: ProtocolId | null) => void;
};

export function ChartPanel({
  doc,
  table,
  spec,
  other,
  protocols,
  protocolId,
  edit,
  footer,
}: {
  doc: DataTables;
  table: DataTable;
  spec: ChartSpec;
  other: ChartSpec | null;
  protocols: readonly ProtocolChoice[];
  protocolId: ProtocolId | null;
  edit: PanelEdit;
  footer?: ReactNode;
}) {
  const linked = protocols.find((p) => p.id === protocolId);
  return (
    <div className="grid gap-8">
      <DataSource doc={doc} table={table} onSheet={edit.sheet} />
      <Section title="Kind of chart">
        <KindTiles table={table} spec={spec} other={other} onType={edit.type} />
      </Section>
      {spec.type === "heatmap" ? <PlateData spec={spec} table={table} edit={edit} /> : <XYData spec={spec} table={table} edit={edit} />}
      {linked === undefined ? null : (
        <p className="text-paragraph-small text-content-secondary">
          Shown on the protocol{" "}
          <a href={protocolHref(linked.id)} className="text-content-accent underline-offset-2 hover:underline">
            {linked.title}
          </a>
          . Change it under More options.
        </p>
      )}
      <MoreOptions spec={spec} table={table} protocols={protocols} protocolId={protocolId} edit={edit} footer={footer} />
      <p className="text-paragraph-xsmall text-content-tertiary">Your file stays as it is. Nothing you do here changes it, and Undo takes back any step.</p>
    </div>
  );
}

function Section({ title, help, children, id }: { title: string; help?: ReactNode; children: ReactNode; id?: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={id ?? headingId} className="min-w-0">
      <h2 id={id ?? headingId} className="text-label-medium text-content-primary">
        {title}
      </h2>
      {help === undefined ? null : <p className="mt-0.5 text-paragraph-small text-content-tertiary">{help}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function DataSource({ doc, table, onSheet }: { doc: DataTables; table: DataTable; onSheet: (name: string) => void }) {
  const sheetId = useId();
  const [notesOpen, setNotesOpen] = useState(false);
  const rows = `${table.rows.toLocaleString("en-US")} ${table.rows === 1 ? "row" : "rows"}`;
  return (
    <div className="min-w-0">
      {doc.tables.length > 1 ? (
        <div className="flex items-center gap-3">
          <label htmlFor={sheetId} className="shrink-0 text-paragraph-small text-content-secondary">
            Sheet
          </label>
          <select id={sheetId} value={table.name} onChange={(e) => onSheet(e.target.value)} className={cn(inputVariants({ size: "compact" }), "min-w-0 flex-1")}>
            {doc.tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <span className="shrink-0 text-paragraph-small text-content-tertiary">{rows}</span>
        </div>
      ) : (
        <p className="text-paragraph-small text-content-tertiary">{rows} in the sheet</p>
      )}
      {table.notes.length === 0 ? null : (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((v) => !v)}
            className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-control px-1 text-paragraph-small text-content-secondary hover:text-content-primary sm:min-h-7"
          >
            <ChevronDownIcon className={cn("size-4 transition-transform duration-150", notesOpen ? "" : "-rotate-90")} />
            Notes from the instrument
          </button>
          {notesOpen ? (
            <div className="mt-1 max-h-60 overflow-y-auto pl-5 text-paragraph-xsmall text-content-tertiary">
              {table.notes.map((n, i) => (
                <p key={i} className="[overflow-wrap:anywhere]">
                  {n}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

const KIND_NAMES = { line: "Line", bar: "Bar", scatter: "Scatter", heatmap: "Heatmap" } satisfies Record<ChartType, string>;

function KindTiles({ table, spec, other, onType }: { table: DataTable; spec: ChartSpec; other: ChartSpec | null; onType: (type: ChartType) => void }) {
  const choices = choicesFor(table);
  return (
    <div role="radiogroup" aria-label="Kind of chart" className={cn("grid gap-2", choices.length === 4 ? "grid-cols-4" : "grid-cols-3")}>
      {choices.map((c) => {
        const problem = switchProblem(spec, c.type, table, other);
        const checked = spec.type === c.type;
        return (
          <button
            key={c.type}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={problem !== null}
            aria-describedby={undefined}
            title={problem ?? c.question}
            onClick={() => {
              if (problem !== null) toast(problem);
              else onType(c.type);
            }}
            className={cn(
              "flex min-h-16 flex-col items-center justify-center gap-1 rounded-control px-1 py-2 text-label-small transition-colors duration-150",
              checked ? "bg-background-secondary text-content-primary ring-2 ring-border-selected ring-inset" : "text-content-secondary ring-1 ring-border-opaque ring-inset hover:bg-background-secondary hover:text-content-primary",
              problem !== null && !checked ? "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-content-secondary" : "",
            )}
          >
            <ChartKindGlyph type={c.type} />
            {KIND_NAMES[c.type]}
            <span className="sr-only">: {problem ?? c.question}</span>
          </button>
        );
      })}
    </div>
  );
}

function XYData({ spec, table, edit }: { spec: XYSpec; table: DataTable; edit: PanelEdit }) {
  const [picking, setPicking] = useState<"bottom" | "measure" | null>(null);
  const x = findColumn(table, spec.x.column);
  const layout = plateLayout(table);
  const wells = layout?.kind === "read" && spec.type !== "bar" ? layout : null;
  const spreads = spreadsFor(spec, table);
  const errorsOn = spec.series.some((s) => s.error !== null);
  const full = spec.series.length >= MAX_SERIES[spec.type];
  const errorNames = [...new Set(spreads.map((s) => findColumn(table, s.error)?.name ?? s.error))];
  return (
    <>
      <Section title="Along the bottom">
        {x === undefined ? null : <ColumnButton column={x} onClick={() => setPicking("bottom")} label="Change what goes along the bottom" />}
      </Section>
      <Section title="What you measured" help={wells === null ? undefined : "Tap a well to draw it as a line. Tap it again to take it off."}>
        {wells === null ? null : <WellPicker layout={wells} spec={spec} table={table} edit={edit} />}
        <ul className={cn("grid gap-1", wells === null ? "" : "mt-4")}>
          {spec.series.map((s) => (
            <SeriesCard key={s.column} spec={spec} series={s} table={table} edit={edit} />
          ))}
        </ul>
        {full ? (
          <p className="mt-2 text-paragraph-xsmall text-content-tertiary">
            {spec.type === "scatter" ? "A scatter chart shows up to three columns." : `This chart is full at ${MAX_SERIES[spec.type]}.`}
          </p>
        ) : (
          <Button variant="tertiary" size="compact" className="mt-1 -ml-3 text-content-secondary" onClick={() => setPicking("measure")}>
            <PlusIcon className="size-5" />
            Add another measurement
          </Button>
        )}
        {spec.series.length > 6 ? <p className="mt-1 text-paragraph-xsmall text-content-tertiary">Past six lines, the colors come round again dashed.</p> : null}
      </Section>
      {spreads.length === 0 ? null : (
        <Switch
          checked={errorsOn}
          onChange={(on) => edit.xy((s) => setErrorBars(s, table, on))}
          label="Show how much your repeats vary"
          help={`Bars above and below each value, from the ${listOf(errorNames)} column.`}
        />
      )}
      <ColumnPicker
        open={picking === "bottom"}
        onClose={() => setPicking(null)}
        title="What goes along the bottom?"
        help={spec.type === "bar" ? "Each row of this column gets its own bar." : "Usually time, an amount, or what you changed between samples."}
        choices={bottomChoices(table, spec.type).filter((c) => !(spec.series.length === 1 && spec.series[0].column === c.column.id))}
        selected={[spec.x.column]}
        onPick={(column) => {
          edit.xy((s) => setBottom(s, table, column));
          setPicking(null);
        }}
      />
      <ColumnPicker
        open={picking === "measure"}
        onClose={() => setPicking(null)}
        title="What did you measure?"
        help="Pick a column of readings to draw on the chart."
        choices={measureChoices(table).map((c) => (c.column.id === spec.x.column ? { ...c, problem: "Already along the bottom" } : c))}
        selected={spec.series.map((s) => s.column)}
        onPick={(column) => {
          edit.xy((s) => addSeries(s, table, column));
          setPicking(null);
        }}
      />
    </>
  );
}

function listOf(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function ColumnButton({ column, onClick, label }: { column: DataColumn; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: now ${columnLabel(column)}`}
      className="flex w-full min-w-0 items-center gap-3 rounded-control bg-background-secondary px-3 py-2.5 text-left ring-1 ring-border-opaque ring-inset transition-colors duration-150 hover:bg-button-secondary-hover"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-label-small text-content-primary">{columnLabel(column)}</span>
        <span className="block truncate text-paragraph-xsmall text-content-tertiary">{columnSample(column)}</span>
      </span>
      <span className="shrink-0 text-paragraph-xsmall text-content-secondary">Change</span>
    </button>
  );
}

function SeriesCard({ spec, series, table, edit }: { spec: XYSpec; series: Series; table: DataTable; edit: PanelEdit }) {
  const column = findColumn(table, series.column);
  const nameId = useId();
  return (
    <li className="group/series flex min-w-0 items-center gap-2 rounded-control py-1 pr-1 pl-1 hover:bg-background-secondary">
      <Popover.Root>
        <Popover.Trigger
          aria-label={`Color and style of ${series.name}`}
          className="flex size-11 shrink-0 items-center justify-center rounded-control hover:bg-background-tertiary sm:size-8"
        >
          <StyleSwatch color={series.color} stroke={series.stroke} type={spec.type} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="left" align="start" sideOffset={8} collisionPadding={12} className={cn(menuSurface, "w-72 p-4")}>
            <SeriesEditor spec={spec} column={series.column} table={table} edit={edit} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <div className="min-w-0 flex-1">
        <label htmlFor={nameId} className="sr-only">
          Name of {column === undefined ? series.name : columnLabel(column)}
        </label>
        <input
          id={nameId}
          value={series.name}
          maxLength={80}
          onChange={(e) => {
            const name = e.target.value;
            edit.xy((s) => editSeries(s, series.column, (q) => ({ ...q, name: name.trim() === "" ? q.name : name })), `name-${series.column}`);
          }}
          className="-ml-1 w-full truncate rounded-[6px] bg-transparent px-1 text-label-small text-content-primary hover:bg-background-tertiary focus:bg-background-raised focus:ring-1 focus:ring-border-accent focus-visible:outline-none"
        />
        {column === undefined ? null : <p className="truncate text-paragraph-xsmall text-content-tertiary">{columnSample(column)}</p>}
      </div>
      {spec.series.length > 1 ? (
        <Button
          variant="tertiary"
          size="compact"
          shape="square"
          className="shrink-0 text-content-tertiary"
          onClick={() => edit.xy((s) => removeSeries(s, table, series.column))}
        >
          <DeleteIcon />
          <span className="sr-only">Take {series.name} off the chart</span>
        </Button>
      ) : null}
    </li>
  );
}

function StyleSwatch({ color, stroke, type }: { color: Series["color"]; stroke: Stroke; type: ChartType }) {
  const fill = `var(--chart-${color})`;
  if (type === "line") {
    return (
      <svg aria-hidden width={20} height={8}>
        <line x1={1} x2={19} y1={4} y2={4} stroke={fill} strokeWidth={2.5} strokeLinecap="round" strokeDasharray={stroke === "dashed" ? "5 3" : undefined} />
      </svg>
    );
  }
  return <span aria-hidden className={cn("size-3.5", type === "bar" ? "rounded-[3px]" : "rounded-full")} style={{ background: fill }} />;
}

// A series' name, color and line, as its swatch in the panel or a click on the chart opens it.
export function SeriesEditor({ spec, column, table, edit, onDone }: { spec: XYSpec; column: ColumnId; table: DataTable; edit: PanelEdit; onDone?: () => void }) {
  const series = spec.series.find((s) => s.column === column);
  const nameId = useId();
  if (series === undefined) return null;
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <label htmlFor={nameId} className="text-label-small text-content-secondary">
          Name
        </label>
        <Input
          id={nameId}
          size="compact"
          maxLength={80}
          value={series.name}
          onChange={(e) => {
            const name = e.target.value;
            edit.xy((s) => editSeries(s, column, (q) => ({ ...q, name: name.trim() === "" ? q.name : name })), `name-${column}`);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onDone?.();
          }}
        />
      </div>
      <div className="grid gap-1.5">
        <span className="text-label-small text-content-secondary">Color</span>
        <div role="radiogroup" aria-label={`Color of ${series.name}`} className="flex flex-wrap gap-1">
          {SERIES_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === series.color}
              aria-label={PALETTE[c].name}
              title={PALETTE[c].name}
              onClick={() => edit.xy((s) => restyle(s, column, { color: c, stroke: series.stroke }))}
              className={cn("flex size-11 items-center justify-center rounded-full sm:size-9", c === series.color ? "ring-2 ring-border-selected ring-inset" : "hover:bg-background-secondary")}
            >
              <span className="size-5 rounded-full" style={{ background: `var(--chart-${c})` }} />
            </button>
          ))}
        </div>
      </div>
      {spec.type === "line" ? (
        <div className="grid gap-1.5">
          <span className="text-label-small text-content-secondary">Line</span>
          <Segmented<Stroke>
            label={`Line of ${series.name}`}
            options={[
              { value: "solid", label: "Solid" },
              { value: "dashed", label: "Dashed" },
            ]}
            value={series.stroke}
            onChange={(stroke) => edit.xy((s) => restyle(s, column, { color: series.color, stroke }))}
          />
        </div>
      ) : null}
      {spec.series.length > 1 ? (
        <Button
          variant="tertiary"
          size="compact"
          className="-ml-3 justify-start text-content-secondary"
          onClick={() => {
            edit.xy((s) => removeSeries(s, table, column));
            onDone?.();
          }}
        >
          Take it off the chart
        </Button>
      ) : null}
    </div>
  );
}

// A kinetic read's wells as a small plate: a well drawn as a line wears its color.
function WellPicker({ layout, spec, table, edit }: { layout: Extract<PlateLayout, { kind: "read" }>; spec: XYSpec; table: DataTable; edit: PanelEdit }) {
  const rows = layout.size === 96 ? 8 : 16;
  const columns = layout.size === 96 ? 12 : 24;
  const byWell = new Map(layout.wells.map((w) => [wellName(w.well), w.column]));
  function toggle(column: DataColumn) {
    const on = spec.series.some((s) => s.column === column.id);
    if (on) {
      if (spec.series.length === 1) return toast("A chart needs at least one line.");
      edit.xy((s) => removeSeries(s, table, column.id));
      return;
    }
    if (spec.series.length >= MAX_SERIES[spec.type]) {
      toast(spec.type === "scatter" ? "A scatter chart shows up to three columns." : `A ${spec.type} chart shows up to ${MAX_SERIES[spec.type]} lines.`);
      return;
    }
    edit.xy((s) => addSeries(s, table, column));
  }
  return (
    <div className="overflow-x-auto">
      <div className="grid w-max gap-[3px]" style={{ gridTemplateColumns: `14px repeat(${columns}, ${layout.size === 96 ? 20 : 11}px)` }}>
        <span />
        {Array.from({ length: columns }, (_, c) => (
          <span key={c} aria-hidden className="text-center text-[10px] leading-4 text-content-tertiary">
            {layout.size === 96 || c % 2 === 0 ? c + 1 : ""}
          </span>
        ))}
        {Array.from({ length: rows }, (_, r) => (
          <WellRow key={r} r={r} columns={columns} byWell={byWell} spec={spec} onToggle={toggle} small={layout.size !== 96} />
        ))}
      </div>
    </div>
  );
}

function WellRow({
  r,
  columns,
  byWell,
  spec,
  onToggle,
  small,
}: {
  r: number;
  columns: number;
  byWell: Map<string, DataColumn>;
  spec: XYSpec;
  onToggle: (c: DataColumn) => void;
  small: boolean;
}) {
  return (
    <>
      <span aria-hidden className="text-[10px] leading-5 text-content-tertiary">
        {rowLetter(r)}
      </span>
      {Array.from({ length: columns }, (_, c) => {
        const name = wellName({ row: r, column: c });
        const column = byWell.get(name);
        const series = column === undefined ? undefined : spec.series.find((s) => s.column === column.id);
        return (
          <button
            key={c}
            type="button"
            disabled={column === undefined}
            aria-pressed={series !== undefined}
            aria-label={`Well ${name}`}
            title={name}
            onClick={() => (column === undefined ? undefined : onToggle(column))}
            className={cn(
              "flex items-center justify-center rounded-full disabled:opacity-30",
              small ? "size-[11px]" : "size-5",
              series === undefined ? "ring-1 ring-border-raised ring-inset hover:bg-background-tertiary" : "",
            )}
            style={series === undefined ? undefined : { background: `var(--chart-${series.color})` }}
          />
        );
      })}
    </>
  );
}

function PlateData({ spec, table, edit }: { spec: HeatmapSpec; table: DataTable; edit: PanelEdit }) {
  const [picking, setPicking] = useState(false);
  const layout = plateLayout(table);
  const source = spec.plate.source;
  if (source.kind === "wells" && layout?.kind === "wells") {
    const value = findColumn(table, source.value);
    return (
      <Section title="Colors show">
        {value === undefined ? null : <ColumnButton column={value} onClick={() => setPicking(true)} label="Change what the colors show" />}
        <ColumnPicker
          open={picking}
          onClose={() => setPicking(false)}
          title="What should the colors show?"
          help="Each well takes its color from this column."
          choices={measureChoices(table).map((c) => (layout.values.some((v) => v.id === c.column.id) ? c : { ...c, problem: c.problem ?? "Not a reading" }))}
          selected={[source.value]}
          onPick={(column) => {
            edit.plate((s) => ({ ...s, plate: { ...s.plate, source: { ...source, value: column.id } }, value: { ...s.value, title: column.name, unit: column.unit ?? "", min: null, max: null } }));
            setPicking(false);
          }}
        />
      </Section>
    );
  }
  if (source.kind === "read" && layout !== null) {
    return <ReadSlider row={source.row} table={table} layout={layout} onRow={(row) => edit.plate((s) => ({ ...s, plate: { ...s.plate, source: { kind: "read", row } } }), "read")} />;
  }
  return null;
}

function readTime(layout: PlateLayout, row: number): string {
  const time = layout.kind === "read" ? layout.time : null;
  const v = time?.values[row];
  if (time === null || v === null || v === undefined) return "";
  return time.kind === "date" ? formatDate(v, time.time) : `${formatValue(v)}${time.unit ? ` ${time.unit}` : ""}`;
}

function ReadSlider({ row, table, layout, onRow }: { row: number; table: DataTable; layout: PlateLayout; onRow: (row: number) => void }) {
  const id = useId();
  const at = readTime(layout, row);
  return (
    <Section title="Which read" help="The plate was read again and again. Slide to pick the moment shown.">
      <label htmlFor={id} className="sr-only">
        Read
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={Math.max(0, table.rows - 1)}
        value={row}
        onChange={(e) => onRow(Number(e.target.value))}
        className="w-full accent-[var(--content-primary)]"
      />
      <p className="mt-1 text-paragraph-small text-content-secondary tabular-nums" aria-live="polite">
        Read {row + 1} of {table.rows}
        {at === "" ? "" : `, at ${at}`}
      </p>
    </Section>
  );
}

// A dialog of a table's columns as cards: name and unit, a few real values, and why a column
// can't be picked when it can't.
function ColumnPicker({
  open,
  onClose,
  title,
  help,
  choices,
  selected,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  help: string;
  choices: readonly { column: DataColumn; problem: string | null }[];
  selected: readonly ColumnId[];
  onPick: (column: DataColumn) => void;
}) {
  const [find, setFind] = useState("");
  const findId = useId();
  const needle = find.trim().toLowerCase();
  const shown = needle === "" ? choices : choices.filter((c) => columnLabel(c.column).toLowerCase().includes(needle));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setFind("");
        }
      }}
    >
      <DialogContent title={title} aria-describedby={undefined} className="sm:w-[min(760px,calc(100vw-80px))]">
        <p className="px-4 pt-1 text-paragraph-medium text-content-secondary sm:px-6">{help}</p>
        {choices.length > 12 ? (
          <div className="relative mx-4 mt-4 sm:mx-6">
            <label htmlFor={findId} className="sr-only">
              Find a column
            </label>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-5 -translate-y-1/2 text-content-tertiary" />
            <Input id={findId} size="compact" type="search" placeholder="Find a column" value={find} onChange={(e) => setFind(e.target.value)} className="pl-9" />
          </div>
        ) : null}
        <ul className="mt-4 grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-2 overflow-y-auto px-4 pb-6 sm:grid-cols-[repeat(2,minmax(0,1fr))] sm:px-6">
          {shown.length === 0 ? <li className="text-paragraph-small text-content-tertiary">No column called that.</li> : null}
          {shown.map(({ column, problem }) => {
            const isSelected = selected.includes(column.id);
            const blocked = problem !== null && !isSelected;
            return (
              <li key={column.id}>
                <button
                  type="button"
                  disabled={blocked}
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() => (isSelected ? onClose() : onPick(column))}
                  className={cn(
                    "flex h-full w-full min-w-0 items-start gap-3 rounded-control px-3.5 py-3 text-left ring-1 ring-inset transition-colors duration-150",
                    isSelected ? "bg-background-secondary ring-2 ring-border-selected" : "ring-border-opaque hover:bg-background-secondary",
                    blocked ? "cursor-not-allowed hover:bg-transparent" : "",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-label-medium", blocked ? "text-content-tertiary" : "text-content-primary")}>{column.name}</span>
                    <span className="mt-0.5 block text-paragraph-small text-content-secondary">
                      {blocked ? problem : [column.unit, isSpreadColumn(column) ? "Spread of repeats, best as error bars" : columnKind(column)].filter(Boolean).join(" · ")}
                    </span>
                    <span className="mt-1 block truncate text-paragraph-xsmall text-content-tertiary tabular-nums">{columnSample(column)}</span>
                  </span>
                  <span className="shrink-0 text-paragraph-xsmall text-content-tertiary"><span className="flex items-center gap-1">{isSelected ? <CheckIcon className="size-4 text-content-primary" /> : null}Sheet column {column.id}</span></span>
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function Switch({ checked, onChange, label, help }: { checked: boolean; onChange: (on: boolean) => void; label: string; help?: string }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-accent",
          checked ? "bg-content-primary" : "bg-background-tertiary ring-1 ring-border-raised ring-inset",
        )}
      >
        <span className={cn("absolute top-1 left-1 size-4 rounded-full bg-background-raised shadow-raised transition-transform duration-150", checked ? "translate-x-4" : "")} />
      </button>
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-label-medium text-content-primary">{label}</span>
        {help === undefined ? null : <span className="mt-0.5 block text-paragraph-small text-content-tertiary">{help}</span>}
      </label>
    </div>
  );
}

function MoreOptions({
  spec,
  table,
  protocols,
  protocolId,
  edit,
  footer,
}: {
  spec: ChartSpec;
  table: DataTable;
  protocols: readonly ProtocolChoice[];
  protocolId: ProtocolId | null;
  edit: PanelEdit;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  return (
    <div className="border-t border-border-opaque pt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((v) => !v)}
        className="-ml-1 flex min-h-11 w-full items-center gap-1.5 rounded-control px-1 text-label-medium text-content-primary hover:text-content-primary sm:min-h-8"
      >
        <ChevronDownIcon className={cn("size-5 transition-transform duration-150", open ? "" : "-rotate-90")} />
        More options
      </button>
      {open ? (
        <div id={regionId} className="mt-4 grid gap-7">
          {spec.type === "heatmap" ? <PlateOptions spec={spec} edit={edit} /> : <XYOptions spec={spec} table={table} edit={edit} />}
          <Option title="Show on a protocol" help="Puts this chart on the protocol's page, under its videos.">
            {(id) => (
              <>
                <select
                  id={id}
                  value={protocolId ?? ""}
                  onChange={(e) => edit.protocol(protocols.find((p) => p.id === e.target.value)?.id ?? null)}
                  className={inputVariants({ size: "compact" })}
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
              </>
            )}
          </Option>
          {footer}
        </div>
      ) : null}
    </div>
  );
}

function Option({ title, help, children }: { title: string; help: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-2">
      <div>
        <label htmlFor={id} className="text-label-small text-content-primary">
          {title}
        </label>
        <p className="text-paragraph-small text-content-tertiary">{help}</p>
      </div>
      {children(id)}
    </div>
  );
}

function XYOptions({ spec, table, edit }: { spec: XYSpec; table: DataTable; edit: PanelEdit }) {
  const xColumn = findColumn(table, spec.x.column);
  const isTime = xColumn?.kind === "date";
  const numbers = numberColumns(table);
  // Columns a series could read along instead of the chart's x: other dates on a time axis, or
  // columns in x's own unit (an AKTA export's volume columns, each in ml). Offered only when a
  // table has them, so most charts never see the choice.
  const ownXChoices =
    spec.type === "bar"
      ? []
      : axisColumns(table).filter(
          (c) =>
            c.id !== spec.x.column &&
            c.kind === xColumn?.kind &&
            (c.kind === "date" || (c.unit !== null && c.unit !== "" && c.unit === (xColumn.kind === "number" ? xColumn.unit : null))),
        );
  const series = (column: ColumnId, f: (s: Series) => Series, group?: string) => edit.xy((s) => editSeries(s, column, f), group);
  return (
    <>
      <Option title="Axis titles" help="Or click a title on the chart to rename it.">
        {(id) => (
          <div className="grid gap-3">
            <TitleAndUnit id={id} label="Bottom" axis={spec.x} noUnit={isTime} onChange={(x) => edit.xy((s) => ({ ...s, x: { ...s.x, ...x } }), "x-title")} />
            <TitleAndUnit label="Side" axis={spec.y} onChange={(y) => edit.xy((s) => ({ ...s, y: { ...s.y, ...y } }), "y-title")} />
          </div>
        )}
      </Option>
      {spec.type === "bar" ? null : (
        <Switch
          checked={spec.y.scale === "log"}
          onChange={(on) => edit.xy((s) => ({ ...s, y: { ...s.y, scale: on ? "log" : "linear", min: null, max: null } }))}
          label="Log scale"
          help="For numbers that span from 1 to 1,000,000. Each step up the side is ten times the last."
        />
      )}
      <Option title="Axis ranges" help="Where each axis starts and ends. Leave blank to fit your data.">
        {(id) => (
          <div className="grid gap-3">
            {spec.type === "bar" ? null : (
              <Range
                id={id}
                label="Bottom"
                axis={spec.x}
                time={isTime && xColumn?.kind === "date" ? xColumn.time : null}
                onChange={(x) => edit.xy((s) => ({ ...s, x: { ...s.x, ...x } }), "x-range")}
              />
            )}
            <Range id={spec.type === "bar" ? id : undefined} label="Side" axis={spec.y} time={null} onChange={(y) => edit.xy((s) => ({ ...s, y: { ...s.y, ...y } }), "y-range")} />
          </div>
        )}
      </Option>
      {spec.series.length >= 2 ? (
        <Option title="Names of the lines" help="Where the legend sits.">
          {(id) => (
            <Segmented<LegendPosition>
              id={id}
              label="Legend"
              options={LEGEND_POSITIONS.map((p) => ({ value: p, label: p === "top" ? "Top" : p === "right" ? "Right" : "Bottom" }))}
              value={spec.legend}
              onChange={(legend) => edit.xy((s) => ({ ...s, legend }))}
            />
          )}
        </Option>
      ) : null}
      <Option title="Error bars" help="The column of ± values for each one. Any column of numbers works.">
        {(id) => (
          <div className="grid gap-2">
            {spec.series.map((s, i) => (
              <PerSeries key={s.column} name={s.name} show={spec.series.length > 1}>
                <select
                  id={i === 0 ? id : undefined}
                  aria-label={`Error bars for ${s.name}`}
                  value={s.error ?? ""}
                  onChange={(e) => series(s.column, (q) => ({ ...q, error: numbers.find((c) => c.id === e.target.value)?.id ?? null }))}
                  className={inputVariants({ size: "compact" })}
                >
                  <option value="">None</option>
                  {numbers
                    .filter((c) => c.id !== s.column && c.id !== spec.x.column)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        ± {columnLabel(c)}
                      </option>
                    ))}
                </select>
              </PerSeries>
            ))}
          </div>
        )}
      </Option>
      {ownXChoices.length === 0 ? null : (
        <Option title="Own column along the bottom" help="For instruments that write a separate bottom column for each curve, like an AKTA run.">
          {(id) => (
            <div className="grid gap-2">
              {spec.series.map((s, i) => (
                <PerSeries key={s.column} name={s.name} show>
                  <select
                    id={i === 0 ? id : undefined}
                    aria-label={`Bottom column for ${s.name}`}
                    value={s.x ?? ""}
                    onChange={(e) => series(s.column, (q) => ({ ...q, x: ownXChoices.find((c) => c.id === e.target.value)?.id ?? null }))}
                    className={inputVariants({ size: "compact" })}
                  >
                    <option value="">{xColumn === undefined ? "The chart's" : `Same as the chart (${columnLabel(xColumn)})`}</option>
                    {ownXChoices
                      .filter((c) => c.id !== s.column && !spec.series.some((q) => q.column === c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {columnLabel(c)}, column {c.id}
                        </option>
                      ))}
                  </select>
                </PerSeries>
              ))}
            </div>
          )}
        </Option>
      )}
    </>
  );
}

function PerSeries({ name, show, children }: { name: string; show: boolean; children: ReactNode }) {
  if (!show) return <>{children}</>;
  return (
    <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-3">
      <span className="truncate text-paragraph-small text-content-secondary">{name}</span>
      {children}
    </div>
  );
}

function PlateOptions({ spec, edit }: { spec: HeatmapSpec; edit: PanelEdit }) {
  return (
    <>
      <Option title="Color scale title" help="Or click it under the plate to rename it.">
        {(id) => <TitleAndUnit id={id} axis={spec.value} onChange={(value) => edit.plate((s) => ({ ...s, value: { ...s.value, ...value } }), "value-title")} />}
      </Option>
      <Option title="Color range" help="The values the palest and the deepest color stand for. Leave blank to fit the wells.">
        {(id) => <Range id={id} axis={spec.value} time={null} onChange={(value) => edit.plate((s) => ({ ...s, value: { ...s.value, ...value } }), "value-range")} />}
      </Option>
    </>
  );
}

export function Segmented<T extends string>({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id?: string;
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div id={id} role="radiogroup" aria-label={label} className="inline-flex w-max rounded-control bg-background-secondary p-0.5 ring-1 ring-border-opaque ring-inset">
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

function TitleAndUnit({
  id,
  label,
  axis,
  noUnit = false,
  onChange,
}: {
  id?: string;
  label?: string;
  axis: { title: string; unit: string };
  noUnit?: boolean;
  onChange: (v: { title?: string; unit?: string }) => void;
}) {
  const unitId = useId();
  const ownId = useId();
  const titleId = id ?? ownId;
  return (
    <div className={cn("grid items-center gap-2", noUnit ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)_6rem]", label === undefined ? "" : "sm:grid-cols-[4rem_minmax(0,1fr)_6rem]")}>
      {label === undefined ? null : <span className="text-paragraph-small text-content-secondary">{label}</span>}
      <Input id={titleId} aria-label={label === undefined ? "Title" : `${label} title`} size="compact" maxLength={80} value={axis.title} placeholder="Title" onChange={(e) => onChange({ title: e.target.value })} />
      {noUnit ? null : (
        <>
          <label htmlFor={unitId} className="sr-only">
            {label === undefined ? "Unit" : `${label} unit`}
          </label>
          <Input id={unitId} size="compact" maxLength={24} value={axis.unit} placeholder="Unit" onChange={(e) => onChange({ unit: e.target.value })} />
        </>
      )}
    </div>
  );
}

// Optional bounds; blank is "fit the data". A time axis takes dates (with times when the
// column has them), read as the wall-clock time the file wrote.
function Range({
  id,
  label,
  axis,
  time,
  onChange,
}: {
  id?: string;
  label?: string;
  axis: { min: number | null; max: number | null };
  time: boolean | null;
  onChange: (v: { min?: number | null; max?: number | null }) => void;
}) {
  const Bound = time === null ? BoundInput : DateBoundInput;
  const toId = useId();
  const ownId = useId();
  const fromId = id ?? ownId;
  const name = label === undefined ? "" : `${label} `;
  return (
    <div className={cn("grid items-center gap-2", label === undefined ? "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:grid-cols-[4rem_minmax(0,1fr)_auto_minmax(0,1fr)]")}>
      {label === undefined ? null : <span className="col-span-3 text-paragraph-small text-content-secondary sm:col-span-1">{label}</span>}
      <Bound id={fromId} label={`${name}from`} value={axis.min} withTime={time ?? false} onChange={(min) => onChange({ min })} />
      <span className="text-paragraph-small text-content-tertiary">to</span>
      <Bound id={toId} label={`${name}to`} value={axis.max} withTime={time ?? false} onChange={(max) => onChange({ max })} />
    </div>
  );
}

type BoundProps = { id: string; label: string; value: number | null; withTime: boolean; onChange: (v: number | null) => void };

function BoundInput({ id, label, value, onChange }: BoundProps) {
  const [text, setText] = useState(value === null ? "" : String(value));
  // A bound cleared from outside (a new column, a new scale, undo) clears the box too.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    const typed = text.trim() === "" ? null : Number(text);
    if (typed !== value) setText(value === null ? "" : String(value));
  }
  return (
    <Input
      id={id}
      aria-label={label}
      size="compact"
      inputMode="decimal"
      placeholder="Fit"
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

function DateBoundInput({ id, label, value, withTime, onChange }: BoundProps) {
  const toText = (ms: number | null) => (ms === null ? "" : new Date(ms).toISOString().slice(0, withTime ? 16 : 10));
  return (
    <Input
      id={id}
      aria-label={label}
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
