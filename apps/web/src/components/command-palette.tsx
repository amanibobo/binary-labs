"use client";

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { folderOf } from "@/lib/format";
import { SearchIcon } from "./icons/base-web";
import { FILE_KIND_ICONS } from "./icons/drawn";
import { useFileSearch } from "./search/use-file-search";
import { buttonVariants } from "./ui/button";
import { Dialog, DialogContent, DialogDock, DialogTrigger } from "./ui/dialog";
import { inputVariants } from "./ui/field";

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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className={cn(
          buttonVariants({ variant: "tertiary", shape: "square", size: "compact" }),
          "sm:w-56 sm:justify-start sm:gap-2 sm:bg-background-secondary sm:px-3 sm:text-paragraph-small sm:text-content-tertiary sm:hover:bg-button-secondary-hover",
        )}
      >
        <SearchIcon className="sm:size-5" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="ml-auto hidden font-sans text-label-xsmall sm:inline">⌘K</kbd>
        <span className="sr-only sm:hidden">Search</span>
      </DialogTrigger>
      <DialogContent title="Search" aria-describedby={undefined}>
        {open ? <PaletteBody onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
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
    <Command shouldFilter={false} label="Search files" className="flex min-h-0 flex-1 flex-col">
      <div className="relative mx-4 mt-4 shrink-0 sm:mx-6">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-content-tertiary" />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search files"
          className={cn(inputVariants(), "pl-12 [&::-webkit-search-cancel-button]:hidden")}
        />
      </div>
      <Command.List className="flex min-h-0 flex-1 flex-col [&_[cmdk-list-sizer]]:flex [&_[cmdk-list-sizer]]:min-h-0 [&_[cmdk-list-sizer]]:flex-1 [&_[cmdk-list-sizer]]:flex-col">
        {q === "" ? (
          <p className="px-4 pt-4 pb-6 text-paragraph-medium text-content-tertiary sm:px-6">
            Type to search names, paths and contents.
          </p>
        ) : (
          <>
            {/* First in the DOM so Enter runs it by default, shown last as the dialog's action. */}
            <DialogDock className="order-last">
              <Command.Item
                value="__search"
                onSelect={() => go(`/?q=${encodeURIComponent(q)}`)}
                className={cn(buttonVariants({ size: "default" }), "w-full cursor-pointer")}
              >
                <span className="truncate">Search all files for &ldquo;{q}&rdquo;</span>
              </Command.Item>
            </DialogDock>
            <div className="min-h-0 flex-1 overflow-y-auto pt-3">
              {data !== undefined && data.results.length > 0 ? (
                <Command.Group
                  heading="Files"
                  className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-label-small [&_[cmdk-group-heading]]:text-content-tertiary sm:[&_[cmdk-group-heading]]:px-6"
                >
                  {data.results.slice(0, 8).map((hit) => {
                    const KindIcon = FILE_KIND_ICONS[hit.fileKind];
                    return (
                      <Command.Item
                        key={hit.sha256}
                        value={hit.sha256}
                        onSelect={() => go(`/?q=${encodeURIComponent(settledQuery)}&open=${hit.sha256}`)}
                        className="flex min-h-16 cursor-pointer items-center gap-4 px-4 py-2 data-[selected=true]:bg-background-secondary sm:px-6"
                      >
                        <KindIcon className="text-content-secondary" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-label-small text-content-primary">
                            {hit.locations[0].originalName}
                          </span>
                          <span className="mt-1 block truncate font-mono text-paragraph-xsmall text-content-tertiary">
                            {folderOf(hit.locations[0])}
                          </span>
                        </span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ) : null}
              {data?.kind === "keyword" ? (
                <p className="px-4 pt-2 text-paragraph-small text-content-tertiary sm:px-6">Results are keyword-only right now.</p>
              ) : null}
            </div>
          </>
        )}
      </Command.List>
    </Command>
  );
}
