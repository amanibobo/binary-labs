"use client";

import Link from "next/link";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { FileHit, Label, LabelCondition, NoteKind } from "@/lib/domain";
import { NoteKind as NoteKinds } from "@/lib/domain";
import { formatDay } from "@/lib/format";
import type { TagRef } from "@/lib/label-edit";
import {
  conditionText,
  isUnclear,
  NOTE_KIND_NAMES,
  OUTCOME_CHOICES,
  SHOWN_CONDITIONS,
  tagCount,
} from "@/lib/row-summary";
import { CheckIcon, PlusIcon } from "../icons/base-web";
import { PencilIcon } from "../icons/drawn";
import { buttonVariants } from "../ui/button";
import { CheckMark } from "./file-label";
import { FollowUpQuestion } from "./follow-up";
import { InlineEdit } from "./inline-edit";
import { useLabels, useLabLists } from "./labels-context";
import { FileRunLine } from "../runs/make-run";
import { RepeatField, RepeatLines } from "./repeats";

const FIELD_NAMES: Record<TagRef["kind"], string> = {
  date: "Date",
  experiment: "Experiment",
  person: "Person",
  instrument: "Instrument",
  free: "Tag",
};

const PLACEHOLDERS: Record<TagRef["kind"], string> = {
  date: "Oct 14 2026",
  experiment: "Experiment",
  person: "Name or initials",
  instrument: "Instrument",
  free: "Tag",
};

// The opened row's labels. At rest they read as a few quiet lines (the summary, then the
// kind, experiment, person, instrument and tags, then the key conditions); the row's header
// already shows the name and date. "Edit labels" opens every field to click and type over, and
// Done or Escape closes it. When Binary is unsure, one line says so with All look right and
// Edit, and offers its two other titles to pick from.
// The row owns whether Edit labels is open, so its E key can open it.
export function LabelsSection({
  hit,
  editing,
  onEditingChange: setEditing,
  className,
}: {
  hit: FileHit;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  className?: string;
}) {
  const labels = useLabels();
  const label = labels.labelOf(hit);
  const headingId = useId();

  if (label === null) {
    return (
      <section aria-label="Labels" className={className}>
        <p className="text-paragraph-small text-content-tertiary">Labeling this file. It takes about a minute.</p>
      </section>
    );
  }
  if (label.status === "needs_look") return <NeedsLookLabels hit={hit} className={className} />;

  const close = (e: KeyboardEvent) => {
    // A field being typed in keeps its own Escape; otherwise Escape leaves editing, not the row.
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      setEditing(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className={cn("min-w-0", className)} onKeyDown={editing ? close : undefined}>
      <h3 id={headingId} className={editing ? "text-label-medium text-content-primary" : "sr-only"}>
        Labels
      </h3>
      {editing ? (
        <EditLabels hit={hit} label={label} onDone={() => setEditing(false)} />
      ) : (
        <ReadLabels hit={hit} label={label} onEdit={() => setEditing(true)} />
      )}
    </section>
  );
}

function NeedsLookLabels({ hit, className }: { hit: FileHit; className?: string }) {
  const labels = useLabels();
  const original = hit.locations[0].originalName;
  return (
    <section aria-label="Labels" className={className}>
      <p className="max-w-prose text-paragraph-small text-content-secondary">
        We couldn&apos;t tell what this is, so it&apos;s waiting in{" "}
        <Link href="/needs-a-look" className="text-content-accent underline-offset-2 hover:underline">
          Needs a look
        </Link>
        . Give it a name and similar files will follow.
      </p>
      <dl data-label-fields className={fieldGrid}>
        <Field name="Name">
          <EditableValue
            field="Name"
            initial=""
            empty="Say what this is"
            inputLabel={`Name for ${original}`}
            placeholder="What is this?"
            onSubmit={(text) => labels.edit(hit, { kind: "rename", text }, `Saved as “${text.trim()}”`)}
          />
        </Field>
      </dl>
    </section>
  );
}

// At rest: what Binary read, in a few lines, and the way to change it.
function ReadLabels({ hit, label, onEdit }: { hit: FileHit; label: Label; onEdit: () => void }) {
  const labels = useLabels();
  const check = label.status === "check";
  const facts = [
    label.noteKind === null || label.noteKind === "other" ? null : NOTE_KIND_NAMES[label.noteKind],
    label.experiment?.name,
    label.person?.name,
    label.instrument,
  ].filter((f): f is string => typeof f === "string" && f.trim() !== "");
  const tags = tagCount(label.tags.length);
  const [tagsOpen, setTagsOpen] = useState(false);
  return (
    <div className="grid gap-2">
      {check ? (
        <div className="grid gap-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-paragraph-small text-content-secondary">
            <CheckMark />
            <span>Binary guessed these labels.</span>
            <span className="inline-flex items-center gap-1">
              <button type="button" onClick={() => labels.accept(hit)} className={quietAction}>
                <CheckIcon className="size-4" />
                All look right
              </button>
              <span aria-hidden className="text-content-tertiary">
                ·
              </span>
              <button type="button" onClick={onEdit} className={quietAction}>
                Edit
              </button>
            </span>
          </p>
          {label.unclear.length > 0 ? <UnclearLine unclear={label.unclear} /> : null}
          {label.alternatives.length > 0 ? <Alternatives hit={hit} label={label} /> : null}
        </div>
      ) : null}
      {label.summary === null ? null : <p className="max-w-prose text-paragraph-small text-content-primary">{label.summary}</p>}
      {facts.length === 0 && tags === null ? null : (
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-paragraph-small text-content-secondary">
          {facts.map((fact, i) => (
            <span key={fact} className="inline-flex items-center gap-1.5">
              {i > 0 ? <span aria-hidden>·</span> : null}
              {fact}
            </span>
          ))}
          {tags === null ? null : (
            <span className="inline-flex items-center gap-1.5">
              {facts.length > 0 ? <span aria-hidden>·</span> : null}
              <button type="button" aria-expanded={tagsOpen} onClick={() => setTagsOpen((o) => !o)} className={dottedToggle}>
                {tags}
              </button>
            </span>
          )}
        </p>
      )}
      {tagsOpen ? (
        <span className="flex flex-wrap gap-1">
          {label.tags.map((tag) => (
            <span key={tag} className="inline-flex h-6 items-center rounded-md bg-background-tertiary px-2 text-label-xsmall text-content-secondary">
              {tag}
            </span>
          ))}
        </span>
      ) : null}
      {label.conditions.length > 0 ? <ConditionsLine conditions={label.conditions} /> : null}
      <RepeatLines hit={hit} label={label} />
      <FileRunLine sha256={hit.sha256} />
      {label.followUp === null ? null : <FollowUpQuestion hit={hit} followUp={label.followUp} />}
      {check ? null : (
        <button type="button" onClick={onEdit} className={cn(quietAction, "justify-self-start")}>
          <PencilIcon className="size-3.5" />
          Edit labels
        </button>
      )}
    </div>
  );
}

// What Binary couldn't read, named, so a person knows what to look at.
function UnclearLine({ unclear }: { unclear: readonly string[] }) {
  return (
    <p className="max-w-prose text-paragraph-small text-content-secondary">
      <span className="text-content-warning">Binary couldn&apos;t read:</span> {unclear.join("; ")}.
    </p>
  );
}

// Binary's two other titles while it's unsure: one tap renames the file, which teaches it.
function Alternatives({ hit, label }: { hit: FileHit; label: Label }) {
  const labels = useLabels();
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-paragraph-small text-content-tertiary">
      <span>Rename to</span>
      {label.alternatives.map((alt) => (
        <button
          key={alt}
          type="button"
          onClick={() => labels.edit(hit, { kind: "rename", text: alt }, `Renamed to “${alt}”`)}
          className="inline-flex min-h-7 items-center rounded-md bg-background-tertiary px-2 text-label-xsmall text-content-primary transition-colors duration-150 ease-out hover:bg-button-secondary-hover max-sm:min-h-11"
        >
          {alt}
        </button>
      ))}
    </p>
  );
}

// The key conditions in one quiet line, the first few with "and N more" for the rest.
function ConditionsLine({ conditions }: { conditions: readonly LabelCondition[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? conditions : conditions.slice(0, SHOWN_CONDITIONS);
  const rest = conditions.length - shown.length;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-paragraph-small text-content-secondary">
      {shown.map((c, i) => (
        <span key={`${c.what}:${i}`} className={cn("inline-flex items-center gap-1.5", isUnclear(c) && "text-content-warning")}>
          {i > 0 ? (
            <span aria-hidden className="text-content-tertiary">
              ·
            </span>
          ) : null}
          {conditionText(c)}
        </span>
      ))}
      {rest > 0 ? (
        <button type="button" onClick={() => setAll(true)} className={dottedToggle}>
          and {rest} more
        </button>
      ) : null}
    </p>
  );
}

// Every field to click and type over, with the lines Binary guessed marked while it's unsure.
function EditLabels({ hit, label, onDone }: { hit: FileHit; label: Label; onDone: () => void }) {
  const labels = useLabels();
  const lists = useLabLists();
  const original = hit.locations[0].originalName;
  const guessed = label.status === "check";
  const facts: { ref: TagRef; value: string | null; suggestions?: readonly string[] }[] = [
    { ref: { kind: "date" }, value: label.date === null ? null : formatDay(label.date) },
    { ref: { kind: "experiment" }, value: label.experiment?.name ?? null, suggestions: lists.experiments.map((e) => e.name) },
    { ref: { kind: "person" }, value: label.person?.name ?? null, suggestions: lists.people.map((p) => p.name) },
    { ref: { kind: "instrument" }, value: label.instrument },
  ];
  return (
    <>
      <p className="mt-0.5 text-paragraph-xsmall text-content-tertiary">
        Click any value to change it. Enter saves, a tap on a choice saves at once, and you can undo.
        {guessed ? (
          <>
            {" "}
            <GuessDot /> marks what Binary guessed.
          </>
        ) : null}
      </p>
      <dl data-label-fields className={fieldGrid}>
        <Field name="Name" guessed={guessed}>
          <EditableValue
            field="Name"
            initial={label.cleanName ?? ""}
            empty="Add a name"
            inputLabel={`Name for ${original}`}
            placeholder="What is this?"
            onSubmit={(text) => labels.edit(hit, { kind: "rename", text }, "Renamed")}
          />
          {label.alternatives.length > 0 ? <Alternatives hit={hit} label={label} /> : null}
        </Field>
        <Field name="Summary" guessed={guessed && label.summary !== null}>
          <EditableValue
            field="Summary"
            initial={label.summary ?? ""}
            empty="Add one sentence"
            inputLabel="Summary"
            placeholder="What it is and what it found"
            onSubmit={(text) => labels.edit(hit, { kind: "summary", text }, text.trim() === "" ? "Summary removed" : "Summary saved")}
            wrap
          />
        </Field>
        <Field name="Outcome" guessed={guessed && label.outcome !== null}>
          <OutcomePicker hit={hit} label={label} />
        </Field>
        {label.outcome === "repeat" || label.repeatOf !== null ? (
          <Field name="Repeat of">
            <RepeatField hit={hit} label={label} />
          </Field>
        ) : null}
        {facts.map(({ ref, value, suggestions }) => {
          const field = FIELD_NAMES[ref.kind];
          return (
            <Field key={ref.kind} name={field} guessed={guessed && value !== null}>
              <EditableValue
                field={field}
                initial={value ?? ""}
                empty={`Add ${field.toLowerCase()}`}
                inputLabel={field}
                placeholder={PLACEHOLDERS[ref.kind]}
                suggestions={suggestions}
                onSubmit={(text) => labels.edit(hit, { kind: "set", tag: ref, text }, text.trim() === "" ? `${field} removed` : `${field} saved`)}
                onRemove={value === null ? undefined : () => void labels.edit(hit, { kind: "remove", tag: ref }, `${field} removed`)}
                removeLabel={`Remove ${field.toLowerCase()} ${value ?? ""}`}
              />
            </Field>
          );
        })}
        <Field name="Kind" guessed={guessed && label.noteKind !== null}>
          <KindPicker hit={hit} value={label.noteKind} />
        </Field>
        {label.conditions.length > 0 ? (
          <Field name="Conditions" guessed={guessed}>
            <ul className="grid gap-0.5">
              {label.conditions.map((c, index) => (
                <li key={`${c.what}:${index}`} className="flex min-w-0 items-center gap-1.5 text-paragraph-small">
                  <span className="shrink-0 text-content-secondary">{c.what}</span>
                  <EditableValue
                    field={c.what}
                    initial={isUnclear(c) || c.value === null ? "" : c.value}
                    empty={isUnclear(c) ? "Not clear, fill in" : "Add a value"}
                    emptyClassName={isUnclear(c) ? "text-content-warning" : undefined}
                    inputLabel={`Value for ${c.what}`}
                    placeholder={c.unit ?? "Value"}
                    suffix={c.unit}
                    onSubmit={(text) => labels.edit(hit, { kind: "condition", index, text }, text.trim() === "" ? "Condition removed" : "Condition saved")}
                  />
                </li>
              ))}
            </ul>
          </Field>
        ) : null}
        <Field name="Tags">
          <span className="flex flex-wrap items-center gap-1.5 max-sm:gap-2">
            {label.tags.map((text, index) => (
              <InlineEdit
                key={`${text}:${index}`}
                initial={text}
                inputLabel="Tag"
                placeholder="Tag"
                onSubmit={(next) => labels.edit(hit, { kind: "set", tag: { kind: "free", index }, text: next }, next.trim() === "" ? "Tag removed" : "Tag saved")}
                onRemove={() => void labels.edit(hit, { kind: "remove", tag: { kind: "free", index } }, "Tag removed")}
                removeLabel={`Remove tag ${text}`}
                inputClassName={tagInput}
                triggerClassName={cn(tagShape, "bg-background-tertiary text-content-secondary hover:bg-button-secondary-hover hover:text-content-primary")}
                trigger={
                  <>
                    <span className="sr-only">Tag: </span>
                    <span className="truncate">{text}</span>
                  </>
                }
              />
            ))}
            <InlineEdit
              initial=""
              inputLabel="New tag"
              placeholder="Tag, date, experiment or person"
              onSubmit={(text) => labels.edit(hit, { kind: "add", text }, "Tag added")}
              inputClassName={cn(tagInput, "w-56")}
              triggerClassName={cn(tagShape, "gap-1 pl-1 text-content-tertiary hover:bg-background-tertiary hover:text-content-primary")}
              trigger={
                <>
                  <PlusIcon className="size-4" />
                  Add tag
                </>
              }
            />
          </span>
        </Field>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={onDone} className={buttonVariants({ variant: "secondary", size: "compact" })}>
          Done
        </button>
        {guessed ? (
          <button type="button" onClick={() => labels.accept(hit)} className={quietAction}>
            <CheckIcon className="size-4" />
            All look right
          </button>
        ) : null}
      </div>
    </>
  );
}

// Worked, failed, repeat, final, unclear, or not a run: one tap each.
function OutcomePicker({ hit, label }: { hit: FileHit; label: Label }) {
  const labels = useLabels();
  return (
    <span role="radiogroup" aria-label="Outcome" className="flex flex-wrap gap-1 py-0.5">
      {OUTCOME_CHOICES.map((choice) => {
        // No outcome yet is no choice made, not "None".
        const on = label.outcome !== null && label.outcome === choice.value;
        return (
          <button
            key={choice.text}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => labels.edit(hit, { kind: "outcome", outcome: choice.value }, choice.value === null ? "Outcome cleared" : `Marked as ${choice.text.toLowerCase()}`)}
            className={cn(
              "inline-flex min-h-7 items-center rounded-md px-2 text-label-xsmall transition-colors duration-150 ease-out max-sm:min-h-11",
              on
                ? choice.value === "failed"
                  ? "bg-background-warning text-content-warning"
                  : "bg-button-primary-fill text-content-inverse-primary"
                : "text-content-secondary ring-1 ring-border-opaque ring-inset hover:bg-background-tertiary",
            )}
          >
            {choice.text}
          </button>
        );
      })}
    </span>
  );
}

function KindPicker({ hit, value }: { hit: FileHit; value: NoteKind | null }) {
  const labels = useLabels();
  return (
    <select
      aria-label="Kind of file"
      value={value ?? ""}
      onChange={(e) => {
        const parsed = NoteKinds.safeParse(e.target.value);
        labels.edit(hit, { kind: "noteKind", noteKind: parsed.success ? parsed.data : null }, "Kind saved");
      }}
      className="h-7 rounded-md border border-border-opaque bg-background-primary px-1.5 text-paragraph-small text-content-primary max-sm:h-10"
    >
      <option value="">Not set</option>
      {NoteKinds.options.map((kind) => (
        <option key={kind} value={kind}>
          {NOTE_KIND_NAMES[kind]}
        </option>
      ))}
    </select>
  );
}

function GuessDot() {
  return <span aria-hidden className="inline-block size-1.5 rounded-full bg-content-warning align-middle" />;
}

const quietAction =
  "inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 text-label-small text-content-primary transition-colors duration-150 ease-out hover:bg-background-tertiary max-sm:min-h-11 -mx-1.5";

const dottedToggle =
  "-mx-1 rounded-md px-1 text-content-secondary underline decoration-content-tertiary decoration-dotted underline-offset-4 transition-colors duration-150 ease-out hover:bg-background-tertiary hover:text-content-primary";

const fieldGrid = "mt-2 grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 max-sm:gap-y-0.5";

// Small gray tags; on phones 32px tall with the hit area stretched to 44px.
const tagShape =
  "relative inline-flex h-6 max-w-full items-center rounded-md px-2 text-label-xsmall transition-colors duration-150 ease-out max-sm:h-8 max-sm:min-w-11 max-sm:justify-center max-sm:after:absolute max-sm:after:-inset-y-1.5 max-sm:after:inset-x-0";

const tagInput = "h-6 w-44 px-1.5 text-label-xsmall max-sm:h-8 max-sm:text-paragraph-medium";

function Field({ name, guessed = false, children }: { name: string; guessed?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-1.5 pt-1 text-paragraph-small text-content-tertiary max-sm:pt-3">
        {name}
        {guessed ? (
          <>
            <GuessDot />
            <span className="sr-only">, guessed</span>
          </>
        ) : null}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

// One fact to click and type over. Empty reads "Add experiment" in the quiet color, and a
// pencil shows on hover and focus so it reads as editable.
function EditableValue({
  field,
  initial,
  empty,
  emptyClassName,
  inputLabel,
  placeholder,
  suggestions,
  suffix,
  wrap = false,
  onSubmit,
  onRemove,
  removeLabel,
}: {
  field: string;
  initial: string;
  empty: string;
  emptyClassName?: string;
  inputLabel: string;
  placeholder: string;
  suggestions?: readonly string[];
  suffix?: string | null;
  wrap?: boolean;
  onSubmit: Parameters<typeof InlineEdit>[0]["onSubmit"];
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const blank = initial.trim() === "";
  return (
    <InlineEdit
      initial={initial}
      inputLabel={inputLabel}
      placeholder={placeholder}
      suggestions={suggestions}
      onSubmit={onSubmit}
      onRemove={onRemove}
      removeLabel={removeLabel}
      className="w-full py-0.5"
      inputClassName="h-7 w-full max-w-80 px-1.5 text-paragraph-small max-sm:h-10 max-sm:text-paragraph-medium"
      triggerClassName={cn(
        "group/value -mx-1.5 flex min-h-7 max-w-[calc(100%+12px)] items-center gap-1.5 rounded-md px-1.5 text-left text-paragraph-small transition-colors duration-150 ease-out hover:bg-background-tertiary max-sm:min-h-11",
        blank ? (emptyClassName ?? "text-content-tertiary") : "text-content-primary",
      )}
      trigger={
        <>
          <span className={wrap ? "py-0.5" : "truncate"}>
            {blank ? empty : initial}
            {blank || suffix === null || suffix === undefined ? null : ` ${suffix}`}
          </span>
          <PencilIcon className="size-3.5 shrink-0 text-content-tertiary opacity-0 transition-opacity duration-150 ease-out group-hover/value:opacity-100 group-focus-visible/value:opacity-100 pointer-coarse:opacity-100" />
          <span className="sr-only">, edit {field.toLowerCase()}</span>
        </>
      }
    />
  );
}
