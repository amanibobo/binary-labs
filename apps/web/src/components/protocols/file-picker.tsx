"use client";

import { useId, useState } from "react";
import type { FileHit } from "@/lib/domain";
import { folderOf } from "@/lib/format";
import type { Sha256 } from "@/lib/ids";
import { cn } from "@/lib/cn";
import { KindIcon } from "../files/kind-icon";
import { CheckIcon } from "../icons/base-web";
import { SearchOutlineIcon } from "../icons/drawn";
import { useFileSearch } from "../search/use-file-search";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDock } from "../ui/dialog";
import { inputVariants } from "../ui/field";
import { Skeleton } from "../ui/skeleton";

// Finds an indexed file with the same search as the home page and links it. Stays open,
// so several files can go on in one visit.
export function FilePicker({
  open,
  onOpenChange,
  linked,
  onLink,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linked: ReadonlySet<Sha256>;
  onLink: (hit: FileHit) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Link a file" aria-describedby={undefined}>
        {open ? <PickerBody linked={linked} onLink={onLink} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PickerBody({ linked, onLink, onDone }: { linked: ReadonlySet<Sha256>; onLink: (hit: FileHit) => void; onDone: () => void }) {
  const [query, setQuery] = useState("");
  const { data, isError } = useFileSearch(query, {});
  const inputId = useId();
  const q = query.trim();

  return (
    <>
      <div className="relative mx-4 mt-4 shrink-0 sm:mx-6">
        <label htmlFor={inputId} className="sr-only">
          Search your lab&apos;s files
        </label>
        <SearchOutlineIcon className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-content-tertiary" />
        <input
          id={inputId}
          type="search"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files"
          className={cn(inputVariants(), "pl-12 [&::-webkit-search-cancel-button]:hidden")}
        />
      </div>
      <div className="min-h-40 flex-1 overflow-y-auto pt-3 pb-2" aria-live="polite">
        {q === "" ? (
          <p className="px-4 pt-1 text-paragraph-medium text-content-tertiary sm:px-6">
            Search by name, folder or contents, like &ldquo;western blot&rdquo; or &ldquo;demo video&rdquo;.
          </p>
        ) : data === undefined ? (
          isError ? (
            <p className="px-4 pt-1 text-paragraph-medium text-content-secondary sm:px-6">Search isn&apos;t working right now.</p>
          ) : (
            <div aria-hidden className="grid gap-3 px-4 pt-2 sm:px-6">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          )
        ) : data.results.length === 0 ? (
          <p className="px-4 pt-1 text-paragraph-medium text-content-secondary sm:px-6">Nothing matches &ldquo;{q}&rdquo;.</p>
        ) : (
          <ul>
            {data.results.map((hit) => (
              <PickerRow key={hit.sha256} hit={hit} isLinked={linked.has(hit.sha256)} onLink={() => onLink(hit)} />
            ))}
          </ul>
        )}
      </div>
      <DialogDock className="border-t border-border-opaque pt-4 sm:pt-5">
        <Button variant="secondary" onClick={onDone}>
          Done
        </Button>
      </DialogDock>
    </>
  );
}

function PickerRow({ hit, isLinked, onLink }: { hit: FileHit; isLinked: boolean; onLink: () => void }) {
  const [primary] = hit.locations;
  const cleanName = hit.label?.cleanName ?? null;
  return (
    <li className="flex min-h-16 items-center gap-4 px-4 py-2 sm:mx-2 sm:rounded-control sm:px-4">
      <KindIcon kind={hit.fileKind} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-label-small text-content-primary", cleanName === null && "font-mono")}>
          {cleanName ?? primary.originalName}
        </span>
        <span className="mt-1 block truncate font-mono text-paragraph-xsmall text-content-tertiary">
          {cleanName === null ? folderOf(primary) : primary.path}
        </span>
      </span>
      {isLinked ? (
        <span className="inline-flex min-h-11 shrink-0 items-center gap-1.5 px-3 text-label-small text-content-tertiary sm:min-h-8">
          <CheckIcon className="size-5" />
          Linked
        </span>
      ) : (
        <Button variant="secondary" size="compact" className="shrink-0" onClick={onLink}>
          Link
          <span className="sr-only"> {cleanName ?? primary.originalName}</span>
        </Button>
      )}
    </li>
  );
}
