"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import type { FileHit, Label } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/format";
import type { TagRef } from "@/lib/label-edit";
import { tagCount, type RowSummary } from "@/lib/row-summary";
import { CheckIcon, PlusIcon } from "../icons/base-web";
import { ChevronSmallIcon, PencilIcon } from "../icons/drawn";
import { buttonVariants } from "../ui/button";
import { InlineEdit } from "./inline-edit";
import { useLabels, useLabLists } from "./labels-context";

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

// The closed row's toggle sits underneath its text; anything here that takes clicks opts back in.
const interactive = "pointer-events-auto relative";

// The file's name on a row: its clean name, or the file name in mono until it has one.
export function RowName({ hit, label }: { hit: FileHit; label: Label | null }) {
  const named = label !== null && label.cleanName !== null;
  return (
    <span className={cn("line-clamp-2 min-w-0 text-label-medium [overflow-wrap:anywhere] text-content-primary sm:line-clamp-1", !named && "font-mono")}>
      {named ? label.cleanName : hit.locations[0].originalName}
    </span>
  );
}

// Amber, small and quiet: the label wants someone to look. It opens with the row, where
// Labels says what to do. The one-time hint points here.
export function CheckMark({ className }: { className?: string }) {
  return (
    <span
      data-hint="check-this"
      className={cn("inline-flex h-5 shrink-0 items-center rounded-md bg-background-warning px-1.5 text-label-xsmall text-content-warning", className)}
    >
      Check this
    </span>
  );
}

// The closed row's one line about its label: the experiment and person as plain words, and
// the tags behind a count that shows them in place.
export function SummaryLine({
  summary,
  tagsOpen,
  onToggleTags,
  tagsId,
  title,
}: {
  summary: RowSummary;
  tagsOpen: boolean;
  onToggleTags: () => void;
  tagsId: string;
  title: string;
}) {
  switch (summary.kind) {
    case "unlabeled":
      return null;
    case "needs_look":
      return <span className="mt-0.5 block text-paragraph-small text-content-tertiary">Not labeled yet, so it&apos;s in Needs a look</span>;
    case "labeled": {
      const count = tagCount(summary.tags.length);
      if (summary.facts.length === 0 && count === null) return null;
      return (
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-paragraph-small text-content-secondary sm:flex-nowrap">
          {summary.facts.length === 0 ? null : <span className="min-w-0 sm:truncate">{summary.facts.join(" · ")}</span>}
          {count === null ? null : (
            // The dot travels with the count, so a wrap never leaves it hanging.
            <span className="inline-flex shrink-0 items-center gap-1.5">
              {summary.facts.length === 0 ? null : <span aria-hidden>·</span>}
              <button
                type="button"
                aria-expanded={tagsOpen}
                aria-controls={tagsId}
                onClick={onToggleTags}
                className={cn(
                  interactive,
                  "-mx-1 inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 text-content-secondary underline decoration-content-tertiary decoration-dotted underline-offset-4 transition-colors duration-150 ease-out hover:bg-background-tertiary hover:text-content-primary max-sm:after:absolute max-sm:after:-inset-y-3 max-sm:after:inset-x-0",
                )}
              >
                {count}
                <ChevronSmallIcon className={cn("size-4 transition-transform duration-150 ease-out", tagsOpen ? "-rotate-90" : "rotate-90")} />
                <span className="sr-only">
                  {tagsOpen ? ", hide" : ", show"} the tags of {title}
                </span>
              </button>
            </span>
          )}
        </span>
      );
    }
    default: {
      const _exhaustive: never = summary;
      return _exhaustive;
    }
  }
}

// The tags a closed row shows in place once their count is clicked. Reading only; they edit
// in the opened row's Labels.
export function TagList({ tags, id }: { tags: readonly string[]; id: string }) {
  return (
    <span id={id} className="mt-1.5 flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span key={tag} className="inline-flex h-6 items-center rounded-md bg-background-tertiary px-2 text-label-xsmall text-content-secondary">
          {tag}
        </span>
      ))}
    </span>
  );
}

// The opened row's labels in one place: the name and every fact as a line to click and
// type over, the tags with Add tag, and Check this with Looks right when we're unsure.
export function LabelsSection({ hit, className }: { hit: FileHit; className?: string }) {
  const labels = useLabels();
  const lists = useLabLists();
  const headingId = useId();
  const label = labels.labelOf(hit);
  const original = hit.locations[0].originalName;

  if (label === null) {
    return (
      <section aria-labelledby={headingId} className={className}>
        <h3 id={headingId} className="text-label-medium text-content-primary">
          Labels
        </h3>
        <p className="mt-1 text-paragraph-small text-content-tertiary">Labeling this file. It takes about a minute.</p>
      </section>
    );
  }

  if (label.status === "needs_look") {
    return (
      <section aria-labelledby={headingId} className={className}>
        <h3 id={headingId} className="text-label-medium text-content-primary">
          Labels
        </h3>
        <p className="mt-1 max-w-prose text-paragraph-small text-content-secondary">
          We couldn&apos;t tell what this is, so it&apos;s waiting in{" "}
          <Link href="/needs-a-look" className="text-content-accent underline-offset-2 hover:underline">
            Needs a look
          </Link>
          . Give it a name and similar files will follow.
        </p>
        <dl className={fieldGrid}>
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

  const check = label.status === "check";
  const facts: { ref: TagRef; value: string | null; suggestions?: readonly string[] }[] = [
    { ref: { kind: "date" }, value: label.date === null ? null : formatDay(label.date) },
    { ref: { kind: "experiment" }, value: label.experiment?.name ?? null, suggestions: lists.experiments.map((e) => e.name) },
    { ref: { kind: "person" }, value: label.person?.name ?? null, suggestions: lists.people.map((p) => p.name) },
    { ref: { kind: "instrument" }, value: label.instrument },
  ];

  return (
    <section aria-labelledby={headingId} className={className}>
      <h3 id={headingId} className="text-label-medium text-content-primary">
        Labels
      </h3>
      <p className="mt-0.5 text-paragraph-xsmall text-content-tertiary">Click any value to change it. Enter saves, and you can undo.</p>
      {check ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-paragraph-small text-content-secondary">
            <CheckMark className="mr-1.5 align-[1px]" />
            Binary guessed these labels. Fixing one, or confirming them all, clears it.
          </p>
          <button
            type="button"
            onClick={() => labels.accept(hit)}
            className={cn(buttonVariants({ variant: "secondary", size: "compact" }), "gap-1 pl-2")}
          >
            <CheckIcon className="size-4" />
            All look right
          </button>
        </div>
      ) : null}
      <dl className={fieldGrid}>
        <Field name="Name">
          <EditableValue
            field="Name"
            initial={label.cleanName}
            empty="Add a name"
            inputLabel={`Name for ${original}`}
            placeholder="What is this?"
            onSubmit={(text) => labels.edit(hit, { kind: "rename", text }, "Renamed")}
          />
        </Field>
        {facts.map(({ ref, value, suggestions }) => {
          const field = FIELD_NAMES[ref.kind];
          return (
            <Field key={ref.kind} name={field}>
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
    </section>
  );
}

const fieldGrid = "mt-2 grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 max-sm:gap-y-0.5";

// Small gray tags; on phones 32px tall with the hit area stretched to 44px.
const tagShape =
  "relative inline-flex h-6 max-w-full items-center rounded-md px-2 text-label-xsmall transition-colors duration-150 ease-out max-sm:h-8 max-sm:min-w-11 max-sm:justify-center max-sm:after:absolute max-sm:after:-inset-y-1.5 max-sm:after:inset-x-0";

const tagInput = "h-6 w-44 px-1.5 text-label-xsmall max-sm:h-8 max-sm:text-paragraph-medium";

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-1 text-paragraph-small text-content-tertiary max-sm:pt-3">{name}</dt>
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
  inputLabel,
  placeholder,
  suggestions,
  onSubmit,
  onRemove,
  removeLabel,
}: {
  field: string;
  initial: string;
  empty: string;
  inputLabel: string;
  placeholder: string;
  suggestions?: readonly string[];
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
        blank ? "text-content-tertiary" : "text-content-primary",
      )}
      trigger={
        <>
          <span className="truncate">{blank ? empty : initial}</span>
          <PencilIcon className="size-3.5 shrink-0 text-content-tertiary opacity-0 transition-opacity duration-150 ease-out group-hover/value:opacity-100 group-focus-visible/value:opacity-100 pointer-coarse:opacity-100" />
          <span className="sr-only">, edit {field.toLowerCase()}</span>
        </>
      }
    />
  );
}
