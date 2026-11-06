"use client";

import { useActionState, useId, useTransition } from "react";
import { toast } from "sonner";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { dataRow, dataSurface } from "@/components/ui/data-table";
import { cn } from "@/lib/cn";
import { localMapHref, MapNodeId } from "@/lib/map";
import { Input, Label } from "@/components/ui/field";
import { addListEntry, removeListEntry, type LabListKind, type ListAddState } from "./actions";

export type LabListEntry = { id: string; name: string; aliases: readonly string[] };

const COPY: Record<LabListKind, { empty: string; nameLabel: string; namePlaceholder: string; aliasLabel: string; aliasPlaceholder: string }> = {
  experiments: {
    empty: "No experiments yet.",
    nameLabel: "New experiment",
    namePlaceholder: "Experiment name",
    aliasLabel: "Other names, separated by commas",
    aliasPlaceholder: "Other names, like TSA",
  },
  people: {
    empty: "No people yet.",
    nameLabel: "New person",
    namePlaceholder: "Full name",
    aliasLabel: "Initials and other names, separated by commas",
    aliasPlaceholder: "Initials, like SL",
  },
};

export function LabListSection({ kind, entries, isAdmin }: { kind: LabListKind; entries: LabListEntry[]; isAdmin: boolean }) {
  const copy = COPY[kind];
  return (
    <div className={dataSurface}>
      {entries.length === 0 ? (
        <p className="px-5 py-4 text-paragraph-medium text-content-tertiary sm:px-6">{copy.empty}</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <li key={entry.id} className={cn(dataRow, "flex min-h-14 items-center gap-4 px-5 py-2 sm:min-h-16 sm:px-6")}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-paragraph-medium text-content-primary">{entry.name}</span>
                {entry.aliases.length === 0 ? null : (
                  <span className="block truncate text-paragraph-small text-content-tertiary">{entry.aliases.join(", ")}</span>
                )}
              </span>
              <Link
                href={localMapHref(MapNodeId.parse(`${kind === "experiments" ? "experiment" : "person"}:${entry.id}`))}
                className={buttonVariants({ variant: "tertiary", size: "compact" })}
              >
                Map<span className="sr-only"> around {entry.name}</span>
              </Link>
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
      variant="secondary"
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
    <form action={action} className="border-t border-border-opaque px-5 py-4 sm:px-6" key={formKey}>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Label htmlFor={`${id}-name`} className="sr-only">
          {copy.nameLabel}
        </Label>
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
        <Label htmlFor={`${id}-aliases`} className="sr-only">
          {copy.aliasLabel}
        </Label>
        <Input
          id={`${id}-aliases`}
          name="aliases"
          autoComplete="off"
          placeholder={copy.aliasPlaceholder}
          defaultValue={error?.aliases ?? ""}
          aria-describedby={`${id}-status`}
        />
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Adding" : "Add"}
        </Button>
      </div>
      <p id={`${id}-status`} role="status" className="text-paragraph-small text-content-tertiary [&:not(:empty)]:mt-2">
        {state.kind === "added" ? `Added ${state.name}.` : state.kind === "error" ? state.message : null}
      </p>
    </form>
  );
}
