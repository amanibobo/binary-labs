"use client";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import type { DataTable } from "@/lib/data-tables";
import type { ProtocolId, Sha256 } from "@/lib/ids";
import {
  assignWells,
  clearWells,
  describeLayout,
  emptyLayout,
  fillSeries,
  groupAt,
  pasteLayout,
  ROLE_HELP,
  ROLE_NAMES,
  ROLES,
  wellsBetween,
  type Role,
  type SampleLayout,
  type SavedLayout,
} from "@/lib/layouts";
import { formatValue } from "@/lib/numbers";
import { PLATE_SHAPE, plateCells, plateLayout, rowLetter, startingSource, wellName, type PlateSize, type Well } from "@/lib/plates";
import type { PlateMap } from "@/lib/summary-guide";
import { ChevronDownIcon } from "../icons/base-web";
import { useLabApi } from "../lab-api";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDock } from "../ui/dialog";
import { Input, inputVariants } from "../ui/field";
import type { ProtocolChoice } from "./chart-builder";
import { Segmented } from "./chart-panel";

// Marking a plate's wells (decisions.md, "charts round 1"): drag across wells, or tap a row
// letter or column number, then say what they are: blank, control, standard (with its amount)
// or sample (with a name, and a dose or a dilution). Wells marked the same are repeats. A
// dilution series fills a run of columns or rows at once; a grid pasted from a spreadsheet
// marks the plate in one go. A layout can be saved on a protocol for the next plate.

// Each role has its own mark as well as its own tint, so a well never says what it is by
// color alone: a letter in the well, and its amount when it has one.
const ROLE_MARK = { blank: "B", control: "C", standard: "S", sample: "" } satisfies Record<Role, string>;
const ROLE_TINT = {
  blank: "bg-background-tertiary text-content-secondary ring-border-raised",
  control: "bg-[color-mix(in_oklab,var(--chart-violet)_22%,var(--background-primary))] text-content-primary ring-[var(--chart-violet)]",
  standard: "bg-[color-mix(in_oklab,var(--chart-blue)_22%,var(--background-primary))] text-content-primary ring-[var(--chart-blue)]",
  sample: "bg-[color-mix(in_oklab,var(--chart-orange)_22%,var(--background-primary))] text-content-primary ring-[var(--chart-orange)]",
} satisfies Record<Role, string>;

export function LayoutPainter({
  open,
  onClose,
  table,
  sha256,
  start,
  protocols,
  protocolId,
  saved,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  table: DataTable;
  sha256: Sha256;
  start: PlateMap | null;
  protocols: readonly ProtocolChoice[];
  protocolId: ProtocolId | null;
  saved: readonly SavedLayout[];
  onDone: (map: PlateMap) => void;
}) {
  const plate = plateLayout(table);
  const size: PlateSize = plate?.size ?? 96;
  const [layout, setLayout] = useState<SampleLayout>(start?.layout ?? emptyLayout(size));
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent
        title="Mark the wells"
        aria-describedby={undefined}
        className="sm:w-[min(1120px,calc(100vw-48px))]"
        // The plate is what's marked first, so it starts focused and in view, not the name field.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          if (e.currentTarget instanceof HTMLElement) e.currentTarget.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.focus({ preventScroll: true });
        }}
      >
        {open ? (
          <PainterBody
            table={table}
            size={size}
            layout={layout}
            setLayout={setLayout}
            picked={picked}
            setPicked={setPicked}
            protocols={protocols}
            protocolId={protocolId}
            sha256={sha256}
            saved={saved}
            onDone={(layoutId, from) => onDone({ layout, layoutId: layoutId ?? start?.layoutId ?? null, from: from ?? (start?.from && start.layout === layout ? start.from : "") })}
            onCancel={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PainterBody({
  table,
  size,
  layout,
  setLayout,
  picked,
  setPicked,
  protocols,
  protocolId,
  sha256,
  saved,
  onDone,
  onCancel,
}: {
  table: DataTable;
  size: PlateSize;
  layout: SampleLayout;
  setLayout: (l: SampleLayout) => void;
  picked: string[];
  setPicked: (w: string[]) => void;
  protocols: readonly ProtocolChoice[];
  protocolId: ProtocolId | null;
  sha256: Sha256;
  saved: readonly SavedLayout[];
  onDone: (layoutId: SavedLayout["id"] | null, from: string | null) => void;
  onCancel: () => void;
}) {
  const plate = plateLayout(table);
  const readings = useMemo(() => {
    if (plate === null) return new Map<string, number | null>();
    return new Map(plateCells(table, plate, startingSource(plate, table)).map((c) => [c.name, c.value]));
  }, [plate, table]);
  const [savedAs, setSavedAs] = useState<{ id: SavedLayout["id"]; from: string } | null>(null);
  return (
    <>
      <div className="grid min-h-0 flex-1 gap-6 overflow-x-hidden overflow-y-auto px-4 pt-1 pb-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="min-w-0">
          <p className="text-paragraph-small text-content-secondary">Drag across wells, or tap a row letter or column number, then say what they are. Wells marked the same are repeats of each other.</p>
          <PlateGrid size={size} layout={layout} readings={readings} picked={picked} onPick={setPicked} />
          <p className="mt-3 text-paragraph-small text-content-secondary" aria-live="polite">
            {describeLayout(layout)}
          </p>
          <Legend />
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <MarkForm layout={layout} picked={picked} onApply={(l) => setLayout(l)} onClear={() => setPicked([])} />
          <Extras layout={layout} picked={picked} onLayout={setLayout} saved={saved} />
          <SaveForLater layout={layout} protocols={protocols} protocolId={protocolId} sha256={sha256} onSaved={(id, from) => setSavedAs({ id, from })} />
        </div>
      </div>
      <DialogDock>
        <Button onClick={() => onDone(savedAs?.id ?? null, savedAs?.from ?? null)} disabled={layout.groups.length === 0}>
          Use this layout
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </DialogDock>
    </>
  );
}

function PlateGrid({
  size,
  layout,
  readings,
  picked,
  onPick,
}: {
  size: PlateSize;
  layout: SampleLayout;
  readings: ReadonlyMap<string, number | null>;
  picked: readonly string[];
  onPick: (wells: string[]) => void;
}) {
  const { rows, columns } = PLATE_SHAPE[size];
  const anchor = useRef<Well | null>(null);
  const dragging = useRef(false);
  const [focus, setFocus] = useState<Well>({ row: 0, column: 0 });
  const grid = useRef<HTMLDivElement>(null);
  const chosen = new Set(picked);
  const small = size === 384;

  const at = (e: ReactPointerEvent): Well | null => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const name = el instanceof HTMLElement ? el.closest<HTMLElement>("[data-well]")?.dataset.well : undefined;
    if (name === undefined) return null;
    const [r, c] = name.split(",").map(Number);
    return { row: r, column: c };
  };

  function key(e: KeyboardEvent<HTMLDivElement>) {
    const move = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      const next = { row: Math.max(0, Math.min(rows - 1, focus.row + move[0])), column: Math.max(0, Math.min(columns - 1, focus.column + move[1])) };
      setFocus(next);
      if (e.shiftKey) onPick(wellsBetween(anchor.current ?? focus, next));
      else anchor.current = next;
      grid.current?.querySelector<HTMLElement>(`[data-well="${next.row},${next.column}"]`)?.focus();
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      const name = wellName(focus);
      onPick(chosen.has(name) ? picked.filter((w) => w !== name) : [...picked, name]);
    } else if (e.key === "Escape" && picked.length > 0) {
      e.stopPropagation();
      onPick([]);
    }
  }

  return (
    <div className="mt-4 overflow-x-auto pb-1">
      <div
        ref={grid}
        role="grid"
        aria-label={`${size}-well plate`}
        aria-multiselectable
        onKeyDown={key}
        className="inline-grid touch-none gap-1 select-none"
        style={{ gridTemplateColumns: `1.5rem repeat(${columns}, minmax(${small ? "1.1rem" : "2.25rem"}, 1fr))` }}
        onPointerUp={() => (dragging.current = false)}
        onPointerLeave={() => (dragging.current = false)}
      >
        <span />
        {Array.from({ length: columns }, (_, c) => (
          <button
            key={`c${c}`}
            type="button"
            tabIndex={-1}
            onClick={() => onPick(wellsBetween({ row: 0, column: c }, { row: rows - 1, column: c }))}
            className="rounded-sm text-center text-paragraph-xsmall text-content-tertiary hover:text-content-primary"
            aria-label={`Pick column ${c + 1}`}
          >
            {c + 1}
          </button>
        ))}
        {Array.from({ length: rows }, (_, r) => (
          <div key={`r${r}`} role="row" className="contents">
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onPick(wellsBetween({ row: r, column: 0 }, { row: r, column: columns - 1 }))}
              className="rounded-sm text-paragraph-xsmall text-content-tertiary hover:text-content-primary"
              aria-label={`Pick row ${rowLetter(r)}`}
            >
              {rowLetter(r)}
            </button>
            {Array.from({ length: columns }, (_, c) => {
              const name = wellName({ row: r, column: c });
              const group = groupAt(layout, name);
              const value = readings.get(name);
              const isPicked = chosen.has(name);
              const label = group === null ? "" : group.conc !== null && group.role !== "control" ? formatValue(group.conc) : ROLE_MARK[group.role] || group.name.slice(0, 3);
              return (
                <button
                  key={name}
                  type="button"
                  role="gridcell"
                  data-well={`${r},${c}`}
                  aria-selected={isPicked}
                  tabIndex={focus.row === r && focus.column === c ? 0 : -1}
                  aria-label={`${name}${group === null ? ", not marked" : `, ${ROLE_NAMES[group.role]}${group.name ? ` ${group.name}` : ""}${group.conc !== null ? ` ${formatValue(group.conc)} ${layout.unit}` : ""}`}${value === null || value === undefined ? "" : `, reads ${formatValue(value)}`}`}
                  title={value === null || value === undefined ? name : `${name}: ${formatValue(value)}`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    dragging.current = true;
                    anchor.current = { row: r, column: c };
                    setFocus({ row: r, column: c });
                    onPick(e.shiftKey && picked.length > 0 ? wellsBetween(anchor.current, { row: r, column: c }) : [name]);
                  }}
                  onPointerMove={(e) => {
                    if (!dragging.current || anchor.current === null) return;
                    const over = at(e);
                    if (over !== null) onPick(wellsBetween(anchor.current, over));
                  }}
                  className={cn(
                    "relative flex aspect-square items-center justify-center rounded-full text-[10px] leading-none font-medium tabular-nums ring-1 transition-shadow ring-inset focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-border-accent",
                    small ? "text-[0px]" : "",
                    group === null ? "bg-background-primary text-content-tertiary ring-border-opaque" : ROLE_TINT[group.role],
                    isPicked ? "ring-[3px] ring-border-selected" : "",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="mt-2 text-paragraph-xsmall text-content-tertiary">
        {picked.length === 0 ? "Nothing picked. Shift and the arrow keys pick from the keyboard too." : `${picked.length} ${picked.length === 1 ? "well" : "wells"} picked: ${picked.length <= 6 ? picked.join(", ") : `${picked[0]} to ${picked.at(-1)}`}.`}
      </p>
    </div>
  );
}

function Legend() {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-paragraph-xsmall text-content-secondary">
      {ROLES.map((r) => (
        <li key={r} className="flex items-center gap-1.5">
          <span className={cn("flex size-4 items-center justify-center rounded-full text-[9px] font-medium ring-1 ring-inset", ROLE_TINT[r])}>{ROLE_MARK[r]}</span>
          {ROLE_NAMES[r]}
        </li>
      ))}
    </ul>
  );
}

const parseNumber = (text: string): number | null => {
  const t = text.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function MarkForm({ layout, picked, onApply, onClear }: { layout: SampleLayout; picked: readonly string[]; onApply: (l: SampleLayout) => void; onClear: () => void }) {
  const first = picked.length === 0 ? null : groupAt(layout, picked[0]);
  const [role, setRole] = useState<Role>("sample");
  const [name, setName] = useState("");
  const [conc, setConc] = useState("");
  const [dilution, setDilution] = useState("");
  const [unit, setUnit] = useState(layout.unit);
  const ids = { name: useId(), conc: useId(), unit: useId(), dilution: useId() };
  // Picking marked wells shows what they are, so a change starts from it.
  const [shown, setShown] = useState<string | null>(null);
  const key = picked.join(" ");
  if (shown !== key) {
    setShown(key);
    if (first !== null) {
      setRole(first.role);
      setName(first.name);
      setConc(first.conc === null ? "" : String(first.conc));
      setDilution(first.dilution === null ? "" : String(first.dilution));
    }
  }
  const needsName = role === "sample";
  const hasConc = role === "standard" || role === "sample";
  const concValue = parseNumber(conc);
  const problem = picked.length === 0 ? "Pick some wells first." : role === "standard" && concValue === null ? "A standard needs its amount." : null;
  function apply() {
    if (problem !== null) return;
    const next = assignWells({ ...layout, unit: unit.trim() || layout.unit }, picked, {
      role,
      name: role === "blank" ? "" : name,
      conc: hasConc ? concValue : role === "control" ? 0 : null,
      dilution: role === "sample" ? parseNumber(dilution) : null,
    });
    onApply(next);
    onClear();
  }
  return (
    <section aria-label="What are these wells?" className="grid gap-3">
      <h3 className="text-label-medium text-content-primary">What are {picked.length === 1 ? "this well" : "these wells"}?</h3>
      <div role="radiogroup" aria-label="Role" className="grid grid-cols-2 gap-1.5">
        {ROLES.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={role === r}
            onClick={() => setRole(r)}
            className={cn(
              "rounded-control px-3 py-2 text-left ring-inset transition-colors duration-150",
              role === r ? "bg-background-secondary ring-2 ring-border-selected" : "ring-1 ring-border-opaque hover:bg-background-secondary",
            )}
          >
            <span className="block text-label-small text-content-primary">{ROLE_NAMES[r]}</span>
            <span className="hidden text-paragraph-xsmall text-content-tertiary sm:block">{ROLE_HELP[r]}</span>
          </button>
        ))}
      </div>
      {needsName || role === "control" ? (
        <div className="grid gap-1">
          <label htmlFor={ids.name} className="text-paragraph-small text-content-secondary">
            {role === "control" ? "Name (optional)" : "Name"}
          </label>
          <Input id={ids.name} size="compact" value={name} maxLength={60} placeholder={role === "control" ? "Vehicle" : "Drug A, or Lysate"} onChange={(e) => setName(e.target.value)} />
        </div>
      ) : null}
      {hasConc ? (
        <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
          <div className="grid gap-1">
            <label htmlFor={ids.conc} className="text-paragraph-small text-content-secondary">
              {role === "standard" ? "Amount" : "Dose (optional)"}
            </label>
            <Input id={ids.conc} size="compact" inputMode="decimal" value={conc} placeholder={role === "standard" ? "250" : "10"} onChange={(e) => setConc(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <label htmlFor={ids.unit} className="text-paragraph-small text-content-secondary">
              Unit
            </label>
            <Input id={ids.unit} size="compact" value={unit} maxLength={24} placeholder="µM" onChange={(e) => setUnit(e.target.value)} />
          </div>
        </div>
      ) : null}
      {role === "sample" ? (
        <div className="grid gap-1">
          <label htmlFor={ids.dilution} className="text-paragraph-small text-content-secondary">
            Diluted how many times? (optional)
          </label>
          <Input id={ids.dilution} size="compact" inputMode="decimal" value={dilution} placeholder="20 for 1 in 20" onChange={(e) => setDilution(e.target.value)} />
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="compact" disabled={problem !== null} onClick={apply} title={problem ?? undefined}>
          Mark {picked.length === 0 ? "wells" : `${picked.length} ${picked.length === 1 ? "well" : "wells"}`}
        </Button>
        {picked.some((w) => groupAt(layout, w) !== null) ? (
          <Button
            size="compact"
            variant="secondary"
            onClick={() => {
              onApply(clearWells(layout, picked));
              onClear();
            }}
          >
            Unmark
          </Button>
        ) : null}
      </div>
      {problem !== null && picked.length > 0 ? <p className="text-paragraph-xsmall text-content-secondary">{problem}</p> : null}
    </section>
  );
}

// A dilution series and a pasted grid: quick ways to mark a whole plate.
function Extras({ layout, picked, onLayout, saved }: { layout: SampleLayout; picked: readonly string[]; onLayout: (l: SampleLayout) => void; saved: readonly SavedLayout[] }) {
  const [open, setOpen] = useState<"series" | "paste" | null>(null);
  const [start, setStart] = useState("100");
  const [factor, setFactor] = useState("10");
  const [direction, setDirection] = useState<"across" | "down">("across");
  const [role, setRole] = useState<"sample" | "standard">("sample");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const ids = { start: useId(), factor: useId(), name: useId(), paste: useId() };
  const steps = new Set(picked.map((w) => (direction === "across" ? w.slice(1) : w[0]))).size;
  const s = parseNumber(start);
  const f = parseNumber(factor);
  const preview = s === null || f === null || steps === 0 ? "" : Array.from({ length: Math.min(steps, 6) }, (_, i) => formatValue(Number((s / f ** i).toPrecision(6)))).join(", ") + (steps > 6 ? ", …" : "");
  const toggle = (which: "series" | "paste") => setOpen((o) => (o === which ? null : which));
  return (
    <section aria-label="Quicker ways" className="grid gap-2 border-t border-border-opaque pt-4">
      <Disclosure open={open === "series"} onClick={() => toggle("series")} label="Fill a dilution series" />
      {open === "series" ? (
        <div className="grid gap-3 pl-6">
          <p className="text-paragraph-xsmall text-content-tertiary">Pick the wells first. Each {direction === "across" ? "column" : "row"} gets one amount; the wells in it are repeats.</p>
          <Segmented<"sample" | "standard">
            label="Of"
            options={[
              { value: "sample", label: "Samples" },
              { value: "standard", label: "Standards" },
            ]}
            value={role}
            onChange={setRole}
          />
          {role === "sample" ? (
            <div className="grid gap-1">
              <label htmlFor={ids.name} className="text-paragraph-small text-content-secondary">
                Name
              </label>
              <Input id={ids.name} size="compact" value={name} placeholder="Drug A" onChange={(e) => setName(e.target.value)} />
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <label htmlFor={ids.start} className="text-paragraph-small text-content-secondary">
                Start at{layout.unit ? ` (${layout.unit})` : ""}
              </label>
              <Input id={ids.start} size="compact" inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="grid gap-1">
              <label htmlFor={ids.factor} className="text-paragraph-small text-content-secondary">
                Divide by
              </label>
              <Input id={ids.factor} size="compact" inputMode="decimal" value={factor} onChange={(e) => setFactor(e.target.value)} />
            </div>
          </div>
          <Segmented<"across" | "down">
            label="Direction"
            options={[
              { value: "across", label: "Across →" },
              { value: "down", label: "Down ↓" },
            ]}
            value={direction}
            onChange={setDirection}
          />
          {preview === "" ? null : <p className="text-paragraph-xsmall text-content-secondary tabular-nums">{preview}</p>}
          <Button
            size="compact"
            variant="secondary"
            className="w-max"
            disabled={picked.length === 0 || s === null || f === null || !(f > 0) || (role === "sample" && name.trim() === "")}
            onClick={() => {
              if (s === null || f === null) return;
              onLayout(fillSeries(layout, picked, { role, name: role === "sample" ? name : "", start: s, factor: f, direction }));
            }}
          >
            Fill {steps === 0 ? "" : `${steps} ${direction === "across" ? (steps === 1 ? "column" : "columns") : steps === 1 ? "row" : "rows"}`}
          </Button>
        </div>
      ) : null}
      <Disclosure open={open === "paste"} onClick={() => toggle("paste")} label="Paste from a spreadsheet" />
      {open === "paste" ? (
        <div className="grid gap-2 pl-6">
          <label htmlFor={ids.paste} className="text-paragraph-xsmall text-content-tertiary">
            Copy the plate&apos;s cells from Excel or Sheets, from A1: words like Blank, Control, Std 250, Drug A 10 µM, or just numbers for amounts.
          </label>
          <textarea id={ids.paste} value={text} onChange={(e) => setText(e.target.value)} rows={5} className={cn(inputVariants({ size: "compact" }), "h-auto py-2 font-mono text-paragraph-xsmall")} />
          <Button
            size="compact"
            variant="secondary"
            className="w-max"
            disabled={text.trim() === ""}
            onClick={() => {
              const result = pasteLayout(layout, text);
              onLayout(result.layout);
              toast(`Marked ${result.wells} ${result.wells === 1 ? "well" : "wells"}${result.skipped > 0 ? `; ${result.skipped} cells were off the plate` : ""}.`);
              setText("");
            }}
          >
            Mark from the paste
          </Button>
        </div>
      ) : null}
      {saved.length === 0 ? null : (
        <div className="grid gap-1.5 pt-1">
          <p className="text-paragraph-small text-content-secondary">Start from a saved layout</p>
          {saved.slice(0, 4).map((l) => (
            <Button key={l.id} size="compact" variant="tertiary" className="-ml-3 w-max max-w-full justify-start truncate text-content-secondary" onClick={() => onLayout(l.layout)}>
              {l.name}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

function Disclosure({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" aria-expanded={open} onClick={onClick} className="-ml-1 inline-flex min-h-11 w-max items-center gap-1.5 rounded-control px-1 text-label-small text-content-primary sm:min-h-8">
      <ChevronDownIcon className={cn("size-4 transition-transform duration-150", open ? "" : "-rotate-90")} />
      {label}
    </button>
  );
}

// Saving the layout for the next plate of a protocol: "Use the layout from Bradford assay".
function SaveForLater({
  layout,
  protocols,
  protocolId,
  sha256,
  onSaved,
}: {
  layout: SampleLayout;
  protocols: readonly ProtocolChoice[];
  protocolId: ProtocolId | null;
  sha256: Sha256;
  onSaved: (id: SavedLayout["id"], from: string) => void;
}) {
  const api = useLabApi();
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<ProtocolId | null>(protocolId);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const ids = { name: useId(), protocol: useId() };
  async function save() {
    setBusy(true);
    try {
      const title = protocols.find((p) => p.id === protocol)?.title;
      const saved = await api.saveLayout({ name: name.trim() || (title === undefined ? "Plate layout" : `${title} layout`), protocolId: protocol, sha256, layout });
      setDone(title === undefined ? `Saved as ${saved.name}.` : `Saved on ${title}. Its next plate can use it.`);
      onSaved(saved.id, `the layout saved as ${saved.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save the layout.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Save for next time" className="grid gap-2 border-t border-border-opaque pt-4">
      <h3 className="text-label-small text-content-primary">Save for the next plate</h3>
      <div className="grid gap-1">
        <label htmlFor={ids.protocol} className="text-paragraph-xsmall text-content-tertiary">
          On a protocol, so its next plate can use this layout
        </label>
        <select id={ids.protocol} value={protocol ?? ""} onChange={(e) => setProtocol(protocols.find((p) => p.id === e.target.value)?.id ?? null)} className={inputVariants({ size: "compact" })}>
          <option value="">No protocol</option>
          {protocols.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </div>
      <label htmlFor={ids.name} className="sr-only">
        Layout name
      </label>
      <Input id={ids.name} size="compact" value={name} maxLength={120} placeholder="Name it (optional)" onChange={(e) => setName(e.target.value)} />
      <Button size="compact" variant="secondary" className="w-max" disabled={busy || layout.groups.length === 0} onClick={() => void save()}>
        {busy ? "Saving" : "Save layout"}
      </Button>
      {done === null ? null : <p className="text-paragraph-xsmall text-content-secondary">{done}</p>}
    </section>
  );
}

