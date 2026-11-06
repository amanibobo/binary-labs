"use client";
import { useId, useMemo, useState, type ReactNode } from "react";
import { analyze, SPREAD_HELP, suggestTest, TEST_NAMES, prepared } from "@/lib/analysis";
import { withRepeats, withSummaryAxis } from "@/lib/chart-edits";
import { SPREADS, TESTS, type HistogramSpec, type Spread, type SummarySpec } from "@/lib/charts";
import { cn } from "@/lib/cn";
import { describeLayout } from "@/lib/layouts";
import { formatFit, formatValue } from "@/lib/numbers";
import { blankOf, groupsOf } from "@/lib/replicates";
import type { ChartData } from "@/lib/summary-guide";
import { Button } from "../ui/button";
import { Input, inputVariants } from "../ui/field";

// The panel's controls for a chart of repeats, where a beginner looks for them: what the bars
// show, every repeat, the blank, the test and the fit. Axis titles, scales and ranges wait
// under More options (summaryOptions).

export type SummaryEdit = (f: (s: SummarySpec | HistogramSpec) => SummarySpec | HistogramSpec, group?: string) => void;

const SPREAD_LABELS = { sd: "SD", sem: "SEM", ci: "95% CI" } satisfies Record<Spread, string>;
const SPREAD_SHORT = {
  sd: "How much the repeats vary.",
  sem: "How sure each mean is. Shrinks with more repeats.",
  ci: "Where each true mean likely lies.",
} satisfies Record<Spread, string>;

function Section({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="text-label-medium text-content-primary">
        {title}
      </h2>
      {help === undefined ? null : <p className="mt-0.5 text-paragraph-small text-content-tertiary">{help}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Choice<T extends string>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex w-max max-w-full flex-wrap rounded-control bg-background-secondary p-0.5 ring-1 ring-border-opaque ring-inset">
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

export function Toggle({ checked, onChange, label, help }: { checked: boolean; onChange: (on: boolean) => void; label: string; help?: string }) {
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

export function SummaryData({ spec, data, edit, onMarkWells }: { spec: SummarySpec | HistogramSpec; data: ChartData; edit: SummaryEdit; onMarkWells: (() => void) | null }) {
  if (spec.type === "histogram") return <HistogramData spec={spec} data={data} edit={edit} />;
  return <RepeatsData spec={spec} data={data} edit={edit} onMarkWells={onMarkWells} />;
}

function RepeatsData({ spec, data, edit, onMarkWells }: { spec: SummarySpec; data: ChartData; edit: SummaryEdit; onMarkWells: (() => void) | null }) {
  const grouped = useMemo(() => groupsOf(data.table, spec.source), [data.table, spec.source]);
  const blank = blankOf(grouped.groups);
  const set = (patch: { spread?: Spread; points?: boolean; blank?: boolean }, group?: string) => edit((s) => (s.type === "histogram" ? s : withRepeats(s, patch)), group);
  const showsBars = !(spec.type === "groups" && spec.mark === "box");
  const maxN = Math.max(0, ...grouped.groups.map((g) => g.repeats.length));
  return (
    <>
      {spec.source.kind === "plate" ? (
        <Section title="Your plate">
          <p className="text-paragraph-small text-content-secondary">{describeLayout(spec.source.layout)}.</p>
          {data.layout?.from ? <p className="mt-0.5 text-paragraph-xsmall text-content-tertiary">From {data.layout.from}.</p> : null}
          {onMarkWells === null ? null : (
            <Button size="compact" variant="secondary" className="mt-2" onClick={onMarkWells}>
              Change the wells
            </Button>
          )}
        </Section>
      ) : null}
      {showsBars ? (
        <Section title={spec.type === "band" ? "What the shading shows" : "What the error bars show"} help={SPREAD_SHORT[spec.spread]}>
          <Choice<Spread> label="Spread" options={SPREADS.map((v) => ({ value: v, label: SPREAD_LABELS[v] }))} value={spec.spread} onChange={(spread) => set({ spread })} />
          <p className="mt-2 text-paragraph-xsmall text-content-tertiary">{SPREAD_HELP[spec.spread]}</p>
        </Section>
      ) : null}
      {spec.type === "band" ? (
        <Toggle checked={spec.band} onChange={(band) => edit((s) => (s.type === "band" ? { ...s, band } : s))} label="Shade the spread" help="Off draws error bars at each point instead." />
      ) : null}
      <Toggle
        checked={spec.points}
        onChange={(points) => set({ points })}
        label="Show every repeat"
        help={maxN <= 10 ? "A dot for each well or repeat. With 10 or fewer, they're best shown." : `A dot for each of up to ${maxN} repeats.`}
      />
      {blank === null ? null : (
        <Toggle
          checked={spec.blank}
          onChange={(on) => set({ blank: on })}
          label="Subtract the blank"
          help={`Takes the mean of ${blank.n} blank ${blank.n === 1 ? "well" : "wells"} (${formatFit(blank.mean)}) off every reading.`}
        />
      )}
      {spec.type === "groups" ? <TestPicker spec={spec} data={data} edit={edit} /> : null}
      {spec.type === "curve" ? <FitPicker spec={spec} data={data} edit={edit} /> : null}
    </>
  );
}

function TestPicker({ spec, data, edit }: { spec: Extract<SummarySpec, { type: "groups" }>; data: ChartData; edit: SummaryEdit }) {
  const id = useId();
  const controlId = useId();
  const groups = useMemo(() => prepared(data.table, spec).groups, [data.table, spec]);
  const suggested = suggestTest(groups);
  const compared = groups.filter((g) => g.role !== "blank");
  const set = (patch: Partial<typeof spec>) => edit((s) => (s.type === "groups" ? { ...s, ...patch } : s));
  return (
    <Section title="Is the difference real?" help={suggested.reason}>
      <label htmlFor={id} className="sr-only">
        Statistical test
      </label>
      <select id={id} value={spec.test} onChange={(e) => set({ test: TESTS.find((t) => t === e.target.value) ?? "none" })} className={cn(inputVariants({ size: "compact" }), "w-full")}>
        {TESTS.map((t) => (
          <option key={t} value={t}>
            {TEST_NAMES[t]}
            {t === suggested.test ? " (suggested)" : ""}
          </option>
        ))}
      </select>
      {spec.test === "control" ? (
        <div className="mt-3 grid gap-1">
          <label htmlFor={controlId} className="text-paragraph-small text-content-secondary">
            Compare each group with
          </label>
          <select id={controlId} value={spec.control ?? ""} onChange={(e) => set({ control: e.target.value || null })} className={inputVariants({ size: "compact" })}>
            {compared.map((g) => (
              <option key={g.id} value={g.label}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {spec.test !== "none" ? (
        <div className="mt-3">
          <Toggle checked={spec.marks} onChange={(marks) => set({ marks })} label="Stars over the groups" help="Only ever shown with the test named under the chart." />
        </div>
      ) : null}
    </Section>
  );
}

function FitPicker({ spec, data, edit }: { spec: Extract<SummarySpec, { type: "curve" }>; data: ChartData; edit: SummaryEdit }) {
  const a = useMemo(() => analyze(data.table, spec, data.tables), [data, spec]);
  const set = (patch: Partial<typeof spec>) => edit((s) => (s.type === "curve" ? { ...s, ...patch } : s));
  return (
    <Section title="Fitted line" help={a.kind === "curve" && a.fit !== null ? `R² ${a.fit.r2.toFixed(4)}. Hover it under the chart for what it means.` : "A straight line through the means, with its equation and R²."}>
      <Choice<"line" | "origin" | "none">
        label="Fitted line"
        options={[
          { value: "line", label: "Straight line" },
          { value: "origin", label: "Through zero" },
          { value: "none", label: "None" },
        ]}
        value={spec.fit}
        onChange={(fit) => set({ fit })}
      />
      <p className="mt-2 text-paragraph-xsmall text-content-tertiary">
        {spec.fit === "origin" ? "Forced through zero: right when a blank-subtracted reading of zero means none there." : spec.fit === "line" ? "Least squares, with its own intercept." : "Dots only, and no samples read off."}
      </p>
    </Section>
  );
}

function HistogramData({ spec, data, edit }: { spec: HistogramSpec; data: ChartData; edit: SummaryEdit }) {
  const a = useMemo(() => analyze(data.table, spec), [data.table, spec]);
  const id = useId();
  const [text, setText] = useState(spec.bin === null ? "" : String(spec.bin));
  const width = a.kind === "histogram" ? a.width : 1;
  const set = (bin: number | null) => edit((s) => (s.type === "histogram" ? { ...s, bin } : s), "bin");
  return (
    <Section title="Bin width" help={a.kind === "histogram" ? a.rule : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="sr-only">
          Bin width
        </label>
        <Input
          id={id}
          size="compact"
          inputMode="decimal"
          className="w-28"
          placeholder={formatValue(width)}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value.replace(",", "."));
            if (e.target.value.trim() === "") set(null);
            else if (Number.isFinite(n) && n > 0) set(n);
          }}
        />
        <span className="text-paragraph-small text-content-tertiary">{spec.x.unit}</span>
        <Button size="compact" variant="tertiary" className="text-content-secondary" onClick={() => set(width / 2)}>
          Narrower
        </Button>
        <Button size="compact" variant="tertiary" className="text-content-secondary" onClick={() => set(width * 2)}>
          Wider
        </Button>
        {spec.bin === null ? null : (
          <Button
            size="compact"
            variant="tertiary"
            className="text-content-secondary"
            onClick={() => {
              setText("");
              set(null);
            }}
          >
            Pick for me
          </Button>
        )}
      </div>
    </Section>
  );
}

// More options for a chart of repeats: the scales, and how a dose curve is fitted.
export function SummaryOptions({ spec, edit, Option }: { spec: SummarySpec | HistogramSpec; edit: SummaryEdit; Option: (p: { title: string; help: string; children: (id: string) => ReactNode }) => ReactNode }) {
  if (spec.type === "histogram") return null;
  const canLogX = spec.type === "curve" || spec.type === "band";
  const canLogY = spec.type !== "groups" || spec.mark === "box";
  return (
    <>
      {canLogX ? (
        <Toggle
          checked={spec.x.scale === "log"}
          onChange={(on) => edit((s) => (s.type === "curve" || s.type === "band" ? withSummaryAxis(s, "x", { scale: on ? "log" : "linear", min: null, max: null }) : s))}
          label="Log scale along the bottom"
          help="For amounts that span from 0.01 to 1,000. Each step along is ten times the last. Zero and below can't be shown."
        />
      ) : null}
      {canLogY ? (
        <Toggle
          checked={spec.y.scale === "log"}
          onChange={(on) => edit((s) => withSummaryAxis(s, "y", { scale: on ? "log" : "linear", min: null, max: null }))}
          label="Log scale up the side"
          help="For readings that span from 1 to 1,000,000."
        />
      ) : null}
      {spec.type === "dose" ? (
        <Option title="Fit the curve to" help="Every well counts each repeat, so its 95% range is honest about how many there are. The means give one point per dose.">
          {(id) => (
            <select id={id} value={spec.fit} onChange={(e) => edit((s) => (s.type === "dose" ? { ...s, fit: e.target.value === "means" ? "means" : "points" } : s))} className={inputVariants({ size: "compact" })}>
              <option value="points">Every well</option>
              <option value="means">The means</option>
            </select>
          )}
        </Option>
      ) : null}
    </>
  );
}
