"use client";

import { useState } from "react";
import { needsCheck, type FileHit, type Label } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import { labelTags, type TagRef } from "@/lib/label-edit";
import { CheckIcon, PlusIcon } from "../icons/base-web";
import { InlineEdit } from "./inline-edit";
import { useLabels } from "./labels-context";

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

const dayFormat = (iso: string) => formatDate(`${iso}T00:00:00Z`);

// The row's toggle button sits underneath; everything here that takes clicks opts back in.
const interactive = "pointer-events-auto relative";

// Small gray tags. Phones get 32px tags in rows 12px apart, with the hit area stretched to 44px.
const tagShape =
  "inline-flex h-6 max-w-full items-center rounded-md px-2 text-label-xsmall transition-colors duration-150 ease-out max-sm:h-8 max-sm:min-w-11 max-sm:justify-center max-sm:after:absolute max-sm:after:-inset-y-1.5 max-sm:after:inset-x-0";

const tagInput = "h-6 w-44 px-1.5 text-label-xsmall max-sm:h-8 max-sm:text-paragraph-medium";

export function LabelTitle({ hit, label }: { hit: FileHit; label: Label | null }) {
  const labels = useLabels();
  const original = hit.locations[0].originalName;
  if (label === null) {
    return <span className="block truncate font-mono text-label-medium text-content-primary">{original}</span>;
  }
  const named = label.cleanName !== null;
  return (
    <InlineEdit
      initial={label.cleanName ?? ""}
      inputLabel={`Name for ${original}`}
      placeholder="What is this?"
      onSubmit={(text) => labels.edit(hit, { kind: "rename", text }, named ? "Renamed" : "Saved")}
      className="-my-1 -ml-2 w-[calc(100%+8px)] max-w-none max-sm:-my-2"
      inputClassName="h-7 w-full px-1.5 text-label-medium max-sm:h-9"
      triggerClassName={cn(
        interactive,
        "-mx-1 flex max-w-[calc(100%+8px)] rounded-md px-1 text-left text-label-medium text-content-primary hover:bg-background-tertiary max-sm:after:absolute max-sm:after:-inset-y-3 max-sm:after:inset-x-0",
        !named && "font-mono",
      )}
      trigger={
        <>
          <span className="truncate">{label.cleanName ?? original}</span>
          <span className="sr-only">{named ? ", rename" : ", say what this is"}</span>
        </>
      }
    />
  );
}

export function LabelTags({ hit, label, expanded }: { hit: FileHit; label: Label; expanded: boolean }) {
  const labels = useLabels();
  if (label.status === "needs_look") return null;
  const tags = labelTags(label, dayFormat);
  return (
    <span className="mt-2 flex flex-wrap items-center gap-1.5 max-sm:gap-x-2 max-sm:gap-y-3">
      {needsCheck(label) ? <CheckMarker onAccept={() => labels.accept(hit)} /> : null}
      {tags.map((tag) => {
        const field = FIELD_NAMES[tag.ref.kind];
        return (
          <InlineEdit
            key={tag.key}
            initial={tag.text}
            inputLabel={field}
            placeholder={PLACEHOLDERS[tag.ref.kind]}
            onSubmit={(text) =>
              labels.edit(hit, { kind: "set", tag: tag.ref, text }, text.trim() === "" ? `${field} removed` : `${field} saved`)
            }
            onRemove={() => {
              labels.edit(hit, { kind: "remove", tag: tag.ref }, `${field} removed`);
            }}
            removeLabel={`Remove ${field.toLowerCase()} ${tag.text}`}
            inputClassName={tagInput}
            triggerClassName={cn(
              interactive,
              tagShape,
              "bg-background-tertiary text-content-secondary hover:bg-button-secondary-hover hover:text-content-primary",
            )}
            trigger={
              <>
                <span className="sr-only">{field}: </span>
                <span className="truncate">{tag.text}</span>
              </>
            }
          />
        );
      })}
      <InlineEdit
        initial=""
        inputLabel="New tag"
        placeholder="Tag, date, experiment or person"
        onSubmit={(text) => labels.edit(hit, { kind: "add", text }, "Tag added")}
        inputClassName={cn(tagInput, "w-56")}
        triggerClassName={cn(
          interactive,
          tagShape,
          "gap-1 pl-1 text-content-tertiary hover:bg-background-tertiary hover:text-content-primary",
          !expanded && "max-sm:hidden pointer-coarse:hidden sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
        )}
        trigger={
          <>
            <PlusIcon className="size-4" />
            Add tag
          </>
        }
      />
    </span>
  );
}

function CheckMarker({ onAccept }: { onAccept: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(interactive, tagShape, "bg-background-warning text-content-warning")}
      >
        Check this
        <span className="sr-only"> label</span>
      </button>
      {open ? (
        <button
          type="button"
          onClick={onAccept}
          className={cn(interactive, tagShape, "gap-1 pl-1 bg-button-primary-fill text-content-inverse-primary hover:bg-button-primary-hover")}
        >
          <CheckIcon className="size-4" />
          Looks right
        </button>
      ) : null}
    </>
  );
}
