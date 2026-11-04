"use client";

import { useActionState, useId, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { dataRow } from "@/components/ui/data-table";
import { cn } from "@/lib/cn";
import { Input, Label } from "@/components/ui/field";
import { addListEntry, removeListEntry, type LabListKind, type ListAddState } from "./actions";

export type LabListEntry = { id: string; name: string; aliases: readonly string[] };

const COPY: Record<LabListKind, { empty: string; aliasLabel: string; aliasPlaceholder: string; namePlaceholder: string; hint: string }> = {
  experiments: {
    empty: "No experiments yet.",
    namePlaceholder: "Thermal shift assay",
    aliasLabel: "Other names",
    aliasPlaceholder: "TSA, DSF",
    hint: "Labels link files to these. Other names are how the experiment shows up in folders and file names, separated by commas.",
  },
  people: {
    empty: "No people yet.",
    namePlaceholder: "Sam Lee",
    aliasLabel: "Initials and other names",
    aliasPlaceholder: "SL, Sam",
    hint: "Labels link files to these. Initials and other names are how the person shows up in folders and file names, separated by commas.",
  },
};

export function LabListSection({ kind, entries, isAdmin }: { kind: LabListKind; entries: LabListEntry[]; isAdmin: boolean }) {
  const copy = COPY[kind];
  return (
    <div>
      {entries.length === 0 ? (
        <p className="px-5 pb-4 text-paragraph-medium text-content-tertiary sm:px-6">{copy.empty}</p>
      ) : (
        <ul className="border-t border-border-opaque">
          {entries.map((entry) => (
            <li key={entry.id} className={cn(dataRow, "flex min-h-14 items-center gap-4 py-2 pr-3 pl-5 sm:pl-6")}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-paragraph-medium text-content-primary">{entry.name}</span>
                {entry.aliases.length === 0 ? null : (
                  <span className="block truncate text-paragraph-small text-content-tertiary">{entry.aliases.join(", ")}</span>
                )}
              </span>
              {isAdmin ? <RemoveButton kind={kind} entry={entry} /> : null}
            </li>
          ))}
        </ul>
      )}
      <AddForm kind={kind} />
    </div>
  );
}

function RemoveButton({ kind, entry }: { kind: LabListKind; entry: LabListEntry }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="tertiary"
      size="compact"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await removeListEntry(kind, entry.id);
          if (result.kind === "error") toast.error(result.message);
        })
      }
    >
      Remove<span className="sr-only"> {entry.name}</span>
    </Button>
  );
}

function AddForm({ kind }: { kind: LabListKind }) {
  const [state, action, pending] = useActionState<ListAddState, FormData>(addListEntry.bind(null, kind), { kind: "idle" });
  const id = useId();
  const copy = COPY[kind];
  const error = state.kind === "error" ? state : null;
  // A new key after each add clears the fields.
  const formKey = state.kind === "added" ? state.name : "draft";
  return (
    <form action={action} className="grid gap-1.5 border-t border-border-opaque bg-background-primary/40 px-5 pt-5 pb-4 sm:px-6" key={formKey}>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            name="name"
            autoComplete="off"
            placeholder={copy.namePlaceholder}
            defaultValue={error?.name ?? ""}
            aria-invalid={error !== null}
            aria-describedby={`${id}-status`}
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-aliases`}>{copy.aliasLabel}</Label>
          <Input
            id={`${id}-aliases`}
            name="aliases"
            autoComplete="off"
            placeholder={copy.aliasPlaceholder}
            defaultValue={error?.aliases ?? ""}
            aria-describedby={`${id}-status`}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Adding" : "Add"}
        </Button>
      </div>
      <p id={`${id}-status`} role="status" className="min-h-6 text-paragraph-small text-content-tertiary">
        {state.kind === "added" ? `Added ${state.name}.` : state.kind === "error" ? state.message : copy.hint}
      </p>
    </form>
  );
}
