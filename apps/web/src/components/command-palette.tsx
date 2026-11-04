"use client";

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { folderOf } from "@/lib/format";
import { SearchIcon } from "./search/search-box";
import { useFileSearch } from "./search/use-file-search";

function isPaletteShortcut(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="flex min-h-11 items-center gap-2 rounded-control border border-hairline bg-surface px-3 text-sm text-muted transition-colors duration-150 ease-out hover:text-ink">
        <SearchIcon className="size-4" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded border border-hairline px-1.5 font-sans text-xs text-muted sm:inline">⌘K</kbd>
        <span className="sr-only sm:hidden">Search</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/25 data-[state=open]:animate-in" />
        <Dialog.Content
          className="fixed top-[12vh] left-1/2 z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-panel border border-hairline bg-surface"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Search files</Dialog.Title>
          {open ? <PaletteBody onDone={() => setOpen(false)} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteBody({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const { data, settledQuery } = useFileSearch(query, {});
  const q = query.trim();
  const go = (href: string) => {
    onDone();
    router.push(href);
  };

  return (
    <Command shouldFilter={false} label="Search files" className="flex max-h-[min(520px,70vh)] flex-col">
      <div className="flex items-center gap-3 border-b border-hairline px-4">
        <SearchIcon className="shrink-0 text-muted" />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search files"
          className="h-14 w-full bg-transparent text-[16px] text-ink placeholder:text-muted/80 focus-visible:outline-none"
        />
      </div>
      <Command.List className="overflow-y-auto p-1.5">
        {q === "" ? (
          <p className="px-3 py-6 text-sm text-muted">Type to search names, paths and contents.</p>
        ) : (
          <>
            <Command.Item
              value="__search"
              onSelect={() => go(`/?q=${encodeURIComponent(q)}`)}
              className="flex min-h-11 cursor-pointer items-center rounded-control px-3 text-[15px] text-ink data-[selected=true]:bg-fill"
            >
              Search all files for &ldquo;{q}&rdquo;
            </Command.Item>
            {data !== undefined && data.results.length > 0 ? (
              <Command.Group
                heading="Files"
                className="mt-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[13px] [&_[cmdk-group-heading]]:text-muted"
              >
                {data.results.slice(0, 8).map((hit) => (
                  <Command.Item
                    key={hit.sha256}
                    value={hit.sha256}
                    onSelect={() => go(`/?q=${encodeURIComponent(settledQuery)}&open=${hit.sha256}`)}
                    className="flex min-h-11 cursor-pointer flex-col justify-center rounded-control px-3 py-1.5 data-[selected=true]:bg-fill"
                  >
                    <span className="w-full truncate font-mono text-[13.5px] text-ink">{hit.locations[0].originalName}</span>
                    <span className="w-full truncate font-mono text-[12px] text-muted">{folderOf(hit.locations[0])}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            {data?.kind === "keyword" ? (
              <p className="px-3 pt-2 pb-1 text-[13px] text-muted">Results are keyword-only right now.</p>
            ) : null}
          </>
        )}
      </Command.List>
    </Command>
  );
}
