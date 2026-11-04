"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import type { FileHit, SearchFilters } from "@/lib/domain";
import { hasFilters, matchesFilters } from "@/lib/filters";
import type { Sha256 } from "@/lib/ids";
import type { LabLists } from "@/lib/label-edit";
import type { SourceState } from "@/lib/source-state";
import { cn } from "@/lib/cn";
import { LabelsProvider, LabListsProvider, useLabelPolling } from "../labels/labels-context";
import { ActiveScan } from "../scan-status";
import { buttonVariants } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { FileResult } from "./file-result";
import { Filters } from "./filters";
import { SearchBox } from "./search-box";
import { useFileSearch } from "./use-file-search";

export function SearchHome({
  labName,
  recent,
  source,
  isAdmin,
  lists,
}: {
  labName: string;
  recent: FileHit[];
  source: SourceState;
  isAdmin: boolean;
  lists: LabLists;
}) {
  const params = useSearchParams();
  const urlQuery = params.get("q") ?? "";
  const urlOpen = params.get("open");
  const [query, setQuery] = useState(urlQuery);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [expanded, setExpanded] = useState<string | null>(urlOpen);
  const inputId = useId();

  // The palette navigates here with ?q=…&open=…; follow it (set during render, per React's guidance).
  const [seenUrl, setSeenUrl] = useState({ q: urlQuery, open: urlOpen });
  if (seenUrl.q !== urlQuery || seenUrl.open !== urlOpen) {
    setSeenUrl({ q: urlQuery, open: urlOpen });
    if (query.trim() !== urlQuery.trim()) setQuery(urlQuery);
    if (urlOpen !== null) setExpanded(urlOpen);
  }

  function updateQuery(next: string) {
    setQuery(next);
    const url = new URL(window.location.href);
    if (next.trim() === "") url.searchParams.delete("q");
    else url.searchParams.set("q", next);
    url.searchParams.delete("open");
    window.history.replaceState(null, "", url);
  }

  const search = useFileSearch(query, filters);
  const searching = query.trim().length > 0;
  const toggle = (sha: Sha256) => setExpanded((current) => (current === sha ? null : sha));

  return (
    <LabListsProvider value={lists}>
      <LabelsProvider>
        <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-24 sm:px-6 sm:pt-16">
          <ActiveScan initial={source} />
          <h1 className="mb-6 text-heading-medium sm:text-heading-xlarge">{labName}</h1>
          <label htmlFor={inputId} className="sr-only">
            Search your lab&apos;s files
          </label>
          <SearchBox
            id={inputId}
            value={query}
            onChange={(e) => updateQuery(e.target.value)}
            placeholder="Search your lab's files"
            autoFocus
          />
          {source.kind === "connected" ? <Filters value={filters} onChange={setFilters} /> : null}

          <section aria-labelledby={`${inputId}-results`} className="mt-10">
            {searching ? (
              <SearchResults search={search} query={search.settledQuery} expanded={expanded} onToggle={toggle} headingId={`${inputId}-results`} filtered={hasFilters(filters)} />
            ) : (
              <RecentFiles
                recent={recent.filter((hit) => matchesFilters(hit, filters))}
                source={source}
                isAdmin={isAdmin}
                filtered={hasFilters(filters)}
                expanded={expanded}
                onToggle={toggle}
                headingId={`${inputId}-results`}
              />
            )}
          </section>
        </div>
      </LabelsProvider>
    </LabListsProvider>
  );
}

function SearchResults({
  search,
  query,
  expanded,
  onToggle,
  headingId,
  filtered,
}: {
  search: ReturnType<typeof useFileSearch>;
  query: string;
  expanded: string | null;
  onToggle: (sha: Sha256) => void;
  headingId: string;
  filtered: boolean;
}) {
  const { data, isError, refetch } = search;
  useLabelPolling(data?.results ?? []);
  if (data === undefined) {
    if (isError) return <SearchError headingId={headingId} onRetry={() => void refetch()} />;
    return (
      <>
        <h2 id={headingId} className="sr-only">
          Results
        </h2>
        <ResultSkeleton />
      </>
    );
  }
  const count = data.results.length;
  return (
    <>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="text-heading-xsmall" aria-live="polite">
          {count === 0 ? "No results" : count === 1 ? "1 result" : `${count} results`}
        </h2>
        {data.kind === "keyword" ? (
          <p className="text-paragraph-small text-content-tertiary">Results are keyword-only right now.</p>
        ) : null}
      </div>
      {count === 0 ? (
        <p className="pt-2 text-paragraph-medium text-content-secondary">
          Nothing matches &ldquo;{query}&rdquo;{filtered ? " with these filters" : ""}.
        </p>
      ) : (
        <ul className="-mx-4 sm:mx-0">
          {data.results.map((hit) => (
            <FileResult key={hit.sha256} hit={hit} query={query} expanded={expanded === hit.sha256} onToggle={() => onToggle(hit.sha256)} />
          ))}
        </ul>
      )}
    </>
  );
}

function SearchError({ headingId, onRetry }: { headingId: string; onRetry: () => void }) {
  return (
    <div>
      <h2 id={headingId} className="text-paragraph-medium text-content-primary">
        Search isn&apos;t working right now.
      </h2>
      <button type="button" onClick={onRetry} className={cn(buttonVariants({ variant: "secondary" }), "mt-3")}>
        Try again
      </button>
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div className="-mx-4 sm:mx-0" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center">
            <Skeleton className="size-6 rounded-md" />
          </div>
          <div className="flex-1 space-y-2.5 border-b border-border-opaque py-4 pr-4">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RecentFiles({
  recent,
  source,
  isAdmin,
  filtered,
  expanded,
  onToggle,
  headingId,
}: {
  recent: FileHit[];
  source: SourceState;
  isAdmin: boolean;
  filtered: boolean;
  expanded: string | null;
  onToggle: (sha: Sha256) => void;
  headingId: string;
}) {
  useLabelPolling(recent);
  if (recent.length === 0) {
    return (
      <div>
        <h2 id={headingId} className={source.kind === "connected" ? "mb-2 text-heading-xsmall" : "sr-only"}>
          Recent files
        </h2>
        <EmptyLab source={source} isAdmin={isAdmin} filtered={filtered} />
      </div>
    );
  }
  return (
    <>
      <h2 id={headingId} className="mb-2 text-heading-xsmall">
        Recent files
      </h2>
      <ul className="-mx-4 sm:mx-0">
        {recent.map((hit) => (
          <FileResult key={hit.sha256} hit={hit} query="" expanded={expanded === hit.sha256} onToggle={() => onToggle(hit.sha256)} />
        ))}
      </ul>
    </>
  );
}

function EmptyLab({ source, isAdmin, filtered }: { source: SourceState; isAdmin: boolean; filtered: boolean }) {
  if (filtered) return <p className="text-paragraph-medium text-content-secondary">No recent files match these filters.</p>;
  switch (source.kind) {
    case "not_connected":
      return isAdmin ? (
        <div>
          <p className="max-w-prose text-paragraph-medium text-content-secondary">
            Connect your lab&apos;s Dropbox to start. Binary Labs reads one folder and never changes a file.
          </p>
          <Link href="/lab" className={cn(buttonVariants(), "mt-4")}>
            Connect Dropbox
          </Link>
        </div>
      ) : (
        <p className="text-paragraph-medium text-content-secondary">Your lab hasn&apos;t connected Dropbox yet. An admin can do it from the lab page.</p>
      );
    case "needs_folder":
      return isAdmin ? (
        <div>
          <p className="text-paragraph-medium text-content-secondary">Dropbox is connected. Pick the folder to index.</p>
          <Link href="/lab/folder" className={cn(buttonVariants(), "mt-4")}>
            Choose folder
          </Link>
        </div>
      ) : (
        <p className="text-paragraph-medium text-content-secondary">An admin is still choosing the folder to index.</p>
      );
    case "connected":
      return <p className="text-paragraph-medium text-content-secondary">Files show up here as they&apos;re indexed.</p>;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}
