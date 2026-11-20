"use client";

import { useId, useState } from "react";
import { BULK_FIELDS, changeFrom, changeTitle, CLEAR, MAX_BULK_FILES, planBulk, planLine, type BulkField } from "@/lib/bulk-labels";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/format";
import type { Sha256 } from "@/lib/ids";
import { OUTCOME_CHOICES } from "@/lib/row-summary";
import { buttonVariants } from "../ui/button";
import { useLabels, useLabLists, type LabeledFile } from "./labels-context";

// Rows picked to change together, kept by hash with the file each was picked from, so a
// file stays picked while the list around it changes (another search, the next page).
export type Selection = {
  picked: ReadonlyMap<Sha256, LabeledFile>;
  // Picking shows a box on every row; it starts with Select and ends with Done or a change.
  picking: boolean;
  toggle: (file: LabeledFile) => void;
  start: () => void;
  clear: () => void;
};

export function useSelection(): Selection {
  const [picked, setPicked] = useState<ReadonlyMap<Sha256, LabeledFile>>(new Map());
  const [started, setStarted] = useState(false);
  return {
    picked,
    picking: started || picked.size > 0,
    toggle: (file) =>
      setPicked((current) => {
        const next = new Map(current);
        if (next.has(file.sha256)) next.delete(file.sha256);
        else if (next.size < MAX_BULK_FILES) next.set(file.sha256, file);
        return next;
      }),
    start: () => setStarted(true),
    clear: () => {
      setPicked(new Map());
      setStarted(false);
    },
  };
}

// The box at the start of a row, there only while picking, so a row at rest stays quiet.
export function SelectBox({ selection, file, name, className }: { selection: Selection; file: LabeledFile; name: string; className?: string }) {
  if (!selection.picking) return null;
  const on = selection.picked.has(file.sha256);
  return (
    <label className={cn("relative z-10 -mx-1.5 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md max-sm:size-11", className)}>
      <input
        type="checkbox"
        checked={on}
        onChange={() => selection.toggle(file)}
        className="size-4 cursor-pointer accent-[var(--content-primary)]"
      />
      <span className="sr-only">Select {name}</span>
    </label>
  );
}

// Beside a list's heading: Select starts picking rows, Done stops.
export function SelectToggle({ selection }: { selection: Selection }) {
  return (
    <button
      type="button"
      onClick={selection.picking ? selection.clear : selection.start}
      aria-pressed={selection.picking}
      className="-my-1 inline-flex min-h-8 items-center rounded-md px-2 text-label-small text-content-secondary transition-colors duration-150 ease-out hover:bg-background-secondary hover:text-content-primary max-sm:min-h-11"
    >
      {selection.picking ? "Done" : "Select"}
    </button>
  );
}

// Under the list while rows are picked: one field, one value, the count of what it will
// change, and Apply. The toast after it has Undo, which puts every file back.
export function BulkBar({ selection }: { selection: Selection }) {
  const labels = useLabels();
  const lists = useLabLists();
  const [field, setField] = useState<BulkField>("experiment");
  const [raw, setRaw] = useState("");
  const fieldId = useId();
  const valueId = useId();
  const files = [...selection.picked.values()];
  if (!selection.picking) return null;

  const count = files.length;
  const input = changeFrom(field, raw, lists);
  const plan = input.kind === "ok" ? planBulk(files.map((f) => ({ sha256: f.sha256, label: labels.labelOf(f) })), input.change) : null;
  const tags = [...new Set(files.flatMap((f) => labels.labelOf(f)?.tags ?? []))].toSorted((a, b) => a.localeCompare(b));
  const changing = plan?.changes.length ?? 0;

  const apply = () => {
    if (input.kind !== "ok" || changing === 0) return;
    labels.editMany(files, input.change, changeTitle(input.change, formatDay));
    setRaw("");
    selection.clear();
  };

  return (
    <section
      aria-label="Change the picked files"
      className="sticky bottom-0 z-20 mt-3 border-t border-border-opaque bg-background-primary px-3 pt-3 pb-4"
    >
      <p className="flex items-baseline justify-between gap-3 text-label-small text-content-primary">
        <span aria-live="polite">
          {count === 0 ? "Pick the files to change" : count === 1 ? "1 file picked" : `${count} files picked`}
        </span>
        {count > 0 ? (
          <button type="button" onClick={selection.clear} className="rounded-md px-1.5 text-label-small text-content-tertiary hover:text-content-primary">
            Clear
          </button>
        ) : null}
      </p>
      {count === 0 ? (
        <p className="mt-1 text-paragraph-small text-content-tertiary">Tick the box on each row, then pick what to change for all of them.</p>
      ) : (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <label htmlFor={fieldId} className="text-paragraph-small text-content-secondary">
            Change
          </label>
          <select
            id={fieldId}
            value={field}
            onChange={(e) => {
              const next = BULK_FIELDS.find((f) => f.field === e.target.value);
              if (next !== undefined) setField(next.field);
              setRaw("");
            }}
            className={control}
          >
            {BULK_FIELDS.map((f) => (
              <option key={f.field} value={f.field}>
                {f.text}
              </option>
            ))}
          </select>
          <label htmlFor={valueId} className="text-paragraph-small text-content-secondary">
            {field === "add_tag" || field === "remove_tag" ? "named" : "to"}
          </label>
          <ValueControl id={valueId} field={field} raw={raw} onChange={setRaw} tags={tags} />
          <button type="submit" disabled={changing === 0} className={buttonVariants({ size: "compact" })}>
            {changing === 0 ? "Apply" : changing === 1 ? "Apply to 1 file" : `Apply to ${changing} files`}
          </button>
        </form>
      )}
      {count > 0 && (plan !== null || input.kind === "invalid") ? (
        <p aria-live="polite" className="mt-1.5 text-paragraph-small text-content-secondary">
          {input.kind === "invalid" ? input.message : plan === null ? null : planLine({ ...plan, changed: plan.changes.length })}
          {plan !== null && changing > 0 ? " You can undo it." : null}
        </p>
      ) : null}
    </section>
  );
}

function ValueControl({ id, field, raw, onChange, tags }: { id: string; field: BulkField; raw: string; onChange: (raw: string) => void; tags: readonly string[] }) {
  const lists = useLabLists();
  const choose = (choices: readonly { value: string; text: string }[], clearText: string | null) => (
    <select id={id} value={raw} onChange={(e) => onChange(e.target.value)} className={control}>
      <option value="">Pick one</option>
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.text}
        </option>
      ))}
      {clearText === null ? null : <option value={CLEAR}>{clearText}</option>}
    </select>
  );
  switch (field) {
    case "experiment":
      return choose(lists.experiments.map((e) => ({ value: e.id, text: e.name })), "No experiment");
    case "person":
      return choose(lists.people.map((p) => ({ value: p.id, text: p.name })), "No person");
    case "outcome":
      return choose(
        OUTCOME_CHOICES.flatMap((c) => (c.value === null ? [] : [{ value: c.value, text: c.text }])),
        "No outcome",
      );
    case "remove_tag":
      return choose(tags.map((t) => ({ value: t, text: t })), null);
    case "date":
    case "instrument":
    case "add_tag":
      return (
        <input
          id={id}
          value={raw}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field === "date" ? "Oct 14 2026" : field === "instrument" ? "Instrument" : "Tag"}
          className={cn(control, "w-44")}
        />
      );
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

const control =
  "h-8 max-w-56 rounded-md border border-border-opaque bg-background-primary px-1.5 text-paragraph-small text-content-primary max-sm:h-11 max-sm:text-paragraph-medium";
