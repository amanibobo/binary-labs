"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  CHECK_KINDS,
  CURVE_FITS,
  CURVE_MEASURES,
  FIT_CHOICES,
  KIND_HELP,
  KIND_NAMES,
  MAX_CHECKS,
  measureFits,
  measureLabel,
  newDraft,
  parseDraft,
  RANGE_KINDS,
  RANGE_NAMES,
  ruleText,
  toDraft,
  usefulText,
  withFit,
  withMeasure,
  type CheckDraft,
  type CheckKind,
  type CheckSpec,
  type DraftField,
} from "@/lib/checks";
import { cn } from "@/lib/cn";
import { usefulnessKey, type UsefulnessByCheck } from "@/lib/flags";
import { CheckId } from "@/lib/ids";
import { NOTE_MAX, protocolHref, type ProtocolVersion } from "@/lib/protocols";
import { DeleteIcon, PlusIcon } from "../icons/base-web";
import { useLabApi } from "../lab-api";
import { CrumbBar } from "../protocols/crumb-bar";
import { Button, buttonVariants } from "../ui/button";
import { dataRow, dataSurface } from "../ui/data-table";
import { Caption, Input, inputVariants, Label } from "../ui/field";

type Problem = { id: CheckId; field: DraftField; message: string };

// The checks of a protocol, edited as one list and saved as one new version.
export function CheckEditor({
  page,
  checks,
  usefulness,
  focus,
}: {
  page: ProtocolVersion;
  checks: readonly CheckSpec[];
  usefulness: UsefulnessByCheck | null;
  // A check to open first: the one a person said flagged wrongly.
  focus: CheckId | null;
}) {
  const api = useLabApi();
  const router = useRouter();
  const [drafts, setDrafts] = useState<CheckDraft[]>(() => checks.map(toDraft));
  const [open, setOpen] = useState<CheckId | null>(focus !== null && checks.some((c) => c.id === focus) ? focus : null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [note, setNote] = useState("");
  const [state, setState] = useState<"editing" | "saving" | "stale">("editing");
  const noteId = useId();

  const update = (id: CheckId, change: Partial<CheckDraft>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...change } : d)));
    if (problem?.id === id) setProblem(null);
  };

  function add(kind: CheckKind) {
    const draft = newDraft(kind, CheckId.parse(crypto.randomUUID()));
    setDrafts((prev) => [...prev, draft]);
    setOpen(draft.id);
  }

  function remove(id: CheckId) {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
    if (problem?.id === id) setProblem(null);
  }

  async function save() {
    const parsed: CheckSpec[] = [];
    for (const d of drafts) {
      const outcome = parseDraft(d);
      if (outcome.kind === "invalid") {
        setProblem({ id: d.id, field: outcome.field, message: outcome.message });
        setOpen(d.id);
        return;
      }
      parsed.push(outcome.check);
    }
    setState("saving");
    try {
      const outcome = await api.saveChecks(page.protocolId, { baseVersionId: page.id, checks: parsed, note: note || null });
      if (outcome.kind === "stale") {
        setState("stale");
        return;
      }
      toast(`Saved as version ${outcome.version}. Its files are checked again.`);
      router.push(protocolHref(page.protocolId));
      router.refresh();
    } catch (error) {
      setState("editing");
      toast.error(error instanceof Error ? error.message : "We couldn't save the checks.");
    }
  }

  return (
    <>
      <CrumbBar items={[{ label: page.title, href: protocolHref(page.protocolId) }, { label: "Checks", href: `${protocolHref(page.protocolId)}/checks` }]} />
      <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-24 sm:px-8 sm:pt-12">
        <h1 className="text-heading-medium sm:text-heading-large">Checks</h1>
        <p className="mt-2 max-w-prose text-paragraph-medium text-content-tertiary">
          Each check runs on this protocol&apos;s data files as they arrive. A result outside its range is flagged. Saving makes version{" "}
          {page.version + 1}.
        </p>

        {state === "stale" ? (
          <div className="mt-6 rounded-control border border-border-opaque bg-background-secondary px-4 py-3 text-paragraph-small text-content-secondary">
            Someone saved a newer version of this protocol while you were editing.{" "}
            <button type="button" className="text-content-accent underline underline-offset-2" onClick={() => router.refresh()}>
              Start again from theirs
            </button>
          </div>
        ) : null}

        {drafts.length === 0 ? (
          <p className="mt-8 text-paragraph-medium text-content-secondary">No checks yet. Pick what to check below.</p>
        ) : (
          <ul className={cn(dataSurface, "mt-8")}>
            {drafts.map((draft) => (
              <li key={draft.id} className={dataRow}>
                <CheckRow
                  draft={draft}
                  open={open === draft.id}
                  onToggle={() => setOpen((cur) => (cur === draft.id ? null : draft.id))}
                  onChange={(change) => update(draft.id, change)}
                  onRemove={() => remove(draft.id)}
                  problem={problem?.id === draft.id ? problem : null}
                  usefulness={usefulness === null ? null : usefulText(usefulness[usefulnessKey(page.protocolId, draft.id)] ?? { flags: 0, useful: 0, wrong: 0, knownIssue: 0 })}
                  focused={focus === draft.id}
                />
              </li>
            ))}
          </ul>
        )}

        {drafts.length < MAX_CHECKS ? <AddCheck onAdd={add} /> : null}

        <div className="mt-10 max-w-xl">
          <Label htmlFor={noteId}>What changed</Label>
          <Input
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={NOTE_MAX}
            placeholder="Optional, shown in the history"
            className="mt-1.5"
          />
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button disabled={state === "saving"} onClick={() => void save()}>
            {state === "saving" ? "Saving" : "Save checks"}
          </Button>
          <Link href={protocolHref(page.protocolId)} className={buttonVariants({ variant: "secondary" })}>
            Cancel
          </Link>
        </div>
      </div>
    </>
  );
}

function AddCheck({ onAdd }: { onAdd: (kind: CheckKind) => void }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="text-heading-xsmall">
        Add a check
      </h2>
      <ul className={cn(dataSurface, "mt-4")}>
        {CHECK_KINDS.map((kind) => (
          <li key={kind} className={dataRow}>
            <button
              type="button"
              onClick={() => onAdd(kind)}
              className="flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors duration-150 ease-out hover:bg-background-secondary focus-visible:outline-offset-[-2px] sm:px-5"
            >
              <PlusIcon className="mt-0.5 size-5 shrink-0 text-content-tertiary" />
              <span className="min-w-0">
                <span className="block text-label-medium text-content-primary">{KIND_NAMES[kind]}</span>
                <span className="mt-0.5 block text-paragraph-small text-content-tertiary">{KIND_HELP[kind]}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CheckRow({
  draft,
  open,
  onToggle,
  onChange,
  onRemove,
  problem,
  usefulness,
  focused,
}: {
  draft: CheckDraft;
  open: boolean;
  onToggle: () => void;
  onChange: (change: Partial<CheckDraft>) => void;
  onRemove: () => void;
  problem: Problem | null;
  usefulness: string | null;
  focused: boolean;
}) {
  const panelId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const parsed = parseDraft(draft);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  return (
    <div ref={ref}>
      <div className="flex items-start gap-2 py-3 pr-2 pl-4 sm:pl-5">
        <button type="button" aria-expanded={open} aria-controls={panelId} onClick={onToggle} className="min-w-0 flex-1 py-1 text-left">
          <span className="block text-label-medium text-content-primary">{draft.name.trim() || KIND_NAMES[draft.kind]}</span>
          <span className="mt-0.5 block text-paragraph-small text-content-secondary">
            {parsed.kind === "ok" ? ruleText(parsed.check) : `${KIND_NAMES[draft.kind]}, not finished`}
          </span>
          {usefulness === null ? null : <span className="mt-0.5 block text-paragraph-xsmall text-content-tertiary">{usefulness}</span>}
        </button>
        <Button variant="tertiary" size="compact" onClick={onToggle}>
          {open ? "Done" : "Edit"}
        </Button>
        <button type="button" onClick={onRemove} className={cn(buttonVariants({ variant: "tertiary", shape: "square", size: "compact" }), "text-content-secondary")}>
          <DeleteIcon />
          <span className="sr-only">Remove {draft.name || KIND_NAMES[draft.kind]}</span>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="form"
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <CheckForm draft={draft} onChange={onChange} problem={problem} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const selectClass = cn(inputVariants({ size: "compact" }), "appearance-auto pr-8");

function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("min-w-0", className)}>
      <Label htmlFor={id} className="text-label-small">
        {label}
      </Label>
      <div className="mt-1.5">{children(id, describedBy)}</div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-paragraph-xsmall text-content-negative">
          {error}
        </p>
      ) : hint ? (
        <Caption id={`${id}-hint`} className="mt-1 text-paragraph-xsmall">
          {hint}
        </Caption>
      ) : null}
    </div>
  );
}

const RANGE_FIELDS = {
  at_least: ["Lowest allowed", null],
  at_most: ["Highest allowed", null],
  between: ["From", "To"],
  around: ["Value", "Give or take"],
} as const;

function CheckForm({ draft, onChange, problem }: { draft: CheckDraft; onChange: (change: Partial<CheckDraft>) => void; problem: Problem | null }) {
  const err = (field: DraftField) => (problem?.field === field ? problem.message : null);
  const text = (field: "name" | "sheet" | "unit" | "x" | "y" | "column" | "row" | "pattern" | "labelColumn", placeholder?: string) =>
    function TextInput(id: string, describedBy: string | undefined) {
      return (
        <Input
          id={id}
          size="compact"
          value={draft[field]}
          placeholder={placeholder}
          aria-invalid={problem?.field === field}
          aria-describedby={describedBy}
          onChange={(e) => onChange({ [field]: e.target.value })}
        />
      );
    };
  const [aLabel, bLabel] = RANGE_FIELDS[draft.range.kind];
  return (
    <div className="grid gap-4 px-4 pt-1 pb-5 sm:grid-cols-2 sm:px-5">
      <Field label="Name" error={err("name")} className="sm:col-span-2">
        {text("name")}
      </Field>

      <KindFields draft={draft} onChange={onChange} text={text} err={err} />

      <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <legend className="sr-only">Allowed range</legend>
        <Field label="Allowed" error={err("range")}>
          {(id) => (
            <select
              id={id}
              className={selectClass}
              value={draft.range.kind}
              onChange={(e) => {
                const kind = RANGE_KINDS.find((k) => k === e.target.value);
                if (kind !== undefined) onChange({ range: { ...draft.range, kind } });
              }}
            >
              {RANGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {RANGE_NAMES[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={aLabel}>
          {(id) => (
            <Input
              id={id}
              size="compact"
              inputMode="decimal"
              className="font-mono"
              value={draft.range.a}
              aria-invalid={problem?.field === "range"}
              onChange={(e) => onChange({ range: { ...draft.range, a: e.target.value } })}
            />
          )}
        </Field>
        {bLabel === null ? null : (
          <Field label={bLabel}>
            {(id) => (
              <Input
                id={id}
                size="compact"
                inputMode="decimal"
                className="font-mono"
                value={draft.range.b}
                aria-invalid={problem?.field === "range"}
                onChange={(e) => onChange({ range: { ...draft.range, b: e.target.value } })}
              />
            )}
          </Field>
        )}
      </fieldset>
      <Field label="Unit" hint="Optional, shown beside the value.">
        {text("unit")}
      </Field>
      <Field label="Table" hint="Leave blank to look in every table of the file.">
        {text("sheet", "Any table")}
      </Field>
    </div>
  );
}

type TextField = "name" | "sheet" | "unit" | "x" | "y" | "column" | "row" | "pattern" | "labelColumn";

function KindFields({
  draft,
  onChange,
  text,
  err,
}: {
  draft: CheckDraft;
  onChange: (change: Partial<CheckDraft>) => void;
  text: (field: TextField, placeholder?: string) => (id: string, describedBy: string | undefined) => ReactNode;
  err: (field: DraftField) => string | null;
}) {
  switch (draft.kind) {
    case "curve_fit": {
      const dose = draft.fit === "4pl";
      return (
        <>
          <Field label="Fit" hint={FIT_CHOICES[draft.fit].hint}>
            {(id, describedBy) => (
              <select
                id={id}
                className={selectClass}
                value={draft.fit}
                aria-describedby={describedBy}
                onChange={(e) => {
                  const fit = CURVE_FITS.find((f) => f === e.target.value);
                  if (fit !== undefined) onChange(withFit(draft, fit));
                }}
              >
                {CURVE_FITS.map((f) => (
                  <option key={f} value={f}>
                    {FIT_CHOICES[f].label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Check" hint={draft.measure === "midpoint" ? "The dose that gives half the full effect." : draft.measure === "outside" ? "Their readings, against the lowest and highest standard." : undefined}>
            {(id, describedBy) => (
              <select
                id={id}
                className={selectClass}
                value={draft.measure}
                aria-describedby={describedBy}
                onChange={(e) => {
                  const measure = CURVE_MEASURES.find((m) => m === e.target.value);
                  if (measure !== undefined) onChange(withMeasure(draft, measure));
                }}
              >
                {CURVE_MEASURES.filter((m) => measureFits(m, draft.fit)).map((m) => (
                  <option key={m} value={m}>
                    {measureLabel(m)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={dose ? "Dose column" : "Concentration column"} hint={dose ? "Blank: found by its name or unit, such as dose or µM." : "Blank: found by its name or unit, such as µg/mL."}>
            {text("x", "Work it out")}
          </Field>
          <Field label="Reading column" hint="Blank: the mean of the readings, or the first one.">
            {text("y", "Work it out")}
          </Field>
        </>
      );
    }
    case "peak":
      return (
        <>
          <Field label="Along column" hint="Blank: wavelength, volume or time.">
            {text("x", "Work it out")}
          </Field>
          <Field label="Reading column" hint="Blank: the first reading after it.">
            {text("y", "Work it out")}
          </Field>
        </>
      );
    case "value":
      return (
        <>
          <Field label="Column" hint="Its name as the file writes it, or its letter." error={err("column")}>
            {text("column", "A260/A280")}
          </Field>
          <Field label="Of the column">
            {(id) => (
              <select
                id={id}
                className={selectClass}
                value={draft.stat}
                onChange={(e) => {
                  const stat = (["mean", "max", "min", "cell"] as const).find((s) => s === e.target.value);
                  if (stat !== undefined) onChange({ stat });
                }}
              >
                <option value="mean">The mean</option>
                <option value="max">The highest</option>
                <option value="min">The lowest</option>
                <option value="cell">One cell</option>
              </select>
            )}
          </Field>
          {draft.stat === "cell" ? (
            <Field label="Row" hint="Text in the row, such as a sample name, or its number." error={err("row")} className="sm:col-span-2">
              {text("row", "BM3 pool")}
            </Field>
          ) : null}
        </>
      );
    case "control":
      return (
        <>
          <Field label="The controls are" hint={draft.by === "column" ? "Such as blank wells read over time, one column each." : "Such as blank wells listed one to a row."}>
            {(id, describedBy) => (
              <select
                id={id}
                className={selectClass}
                value={draft.by}
                aria-describedby={describedBy}
                onChange={(e) => onChange({ by: e.target.value === "column" ? "column" : "row" })}
              >
                <option value="row">Rows</option>
                <option value="column">Columns</option>
              </select>
            )}
          </Field>
          {draft.by === "column" ? (
            <Field label="Control columns are called" hint="Any column whose header has this in it, such as Blank 1." error={err("pattern")}>
              {text("pattern", "blank")}
            </Field>
          ) : (
            <>
              <Field label="Control rows are called" hint="Any row whose name has this in it." error={err("pattern")}>
                {text("pattern", "blank")}
              </Field>
              <Field label="Column to read" error={err("column")}>
                {text("column", "A595")}
              </Field>
              <Field label="Names in column" hint="Blank: any text column.">
                {text("labelColumn", "Any text column")}
              </Field>
            </>
          )}
          <Field label="Judge">
            {(id) => (
              <select
                id={id}
                className={selectClass}
                value={draft.use}
                onChange={(e) => onChange({ use: e.target.value === "mean" ? "mean" : "each" })}
              >
                <option value="each">Every control</option>
                <option value="mean">Their mean</option>
              </select>
            )}
          </Field>
        </>
      );
    default: {
      const _exhaustive: never = draft.kind;
      return _exhaustive;
    }
  }
}
