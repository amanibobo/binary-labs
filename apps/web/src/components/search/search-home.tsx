"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { areaHref } from "@/app/lab/areas";
import type { FileHit, SearchFilters } from "@/lib/domain";
import { hasFilters, matchesFilters } from "@/lib/filters";
import type { Sha256 } from "@/lib/ids";
import type { LabLists } from "@/lib/label-edit";
import { hasIndex, type SourceState } from "@/lib/source-state";
import { cn } from "@/lib/cn";
import { LabelsProvider, LabListsProvider, useLabelPolling } from "../labels/labels-context";
import { ActiveScan } from "../scan-status";
import { buttonVariants } from "../ui/button";
import { dataSurface } from "../ui/data-table";
import { Skeleton } from "../ui/skeleton";
import { ProtocolResults } from "../protocols/protocol-results";
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
        <div className="mx-auto w-full max-w-4xl px-4 pt-8 pb-24 sm:px-8 sm:pt-16">
          <ActiveScan initial={source} />
          <h1 className="mb-6 text-heading-medium sm:text-heading-large">{labName}</h1>
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
          {hasIndex(source) ? <Filters value={filters} onChange={setFilters} /> : null}

          <section aria-labelledby={`${inputId}-results`} className="mt-12">
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
  // With pages above, the count below says what it counts.
  const noun = data.protocols.length > 0 ? ["file", "files"] : ["result", "results"];
  return (
    <>
      <ProtocolResults hits={data.protocols} query={query} />
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="text-heading-xsmall" aria-live="polite">
          {count === 0 ? `No ${noun[1]}` : count === 1 ? `1 ${noun[0]}` : `${count} ${noun[1]}`}
        </h2>
        {data.kind === "keyword" ? (
          <p className="text-paragraph-small text-content-tertiary">Showing exact word matches only right now.</p>
        ) : null}
      </div>
      {count === 0 ? (
        <p className="pt-2 text-paragraph-medium text-content-secondary">
          {data.protocols.length > 0 ? "No files match" : "Nothing matches"} &ldquo;{query}&rdquo;{filtered ? " with these filters" : ""}.
        </p>
      ) : (
        <ul className={dataSurface}>
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
    <div className={dataSurface} aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-4 border-t border-border-opaque py-4 pr-4 pl-4 first:border-t-0 sm:pl-5">
          <Skeleton className="size-6 shrink-0 rounded-md" />
          <div className="flex-1 space-y-2.5">
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
        <h2 id={headingId} className={hasIndex(source) ? "mb-2 text-heading-xsmall" : "sr-only"}>
          Recent files
        </h2>
        <EmptyLab source={source} isAdmin={isAdmin} filtered={filtered} />
      </div>
    );
  }
  return (
    <>
      <h2 id={headingId} className="mb-4 text-heading-xsmall">
        Recent files
      </h2>
      <ul className={dataSurface}>
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
          <Link href={areaHref("dropbox")} className={cn(buttonVariants(), "mt-4")}>
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
    case "disconnected":
      return isAdmin ? (
        <div>
          <p className="max-w-prose text-paragraph-medium text-content-secondary">
            Dropbox is disconnected, so no new files are read. Connect it again from Settings.
          </p>
          <Link href={areaHref("dropbox")} className={cn(buttonVariants(), "mt-4")}>
            Open settings
          </Link>
        </div>
      ) : (
        <p className="text-paragraph-medium text-content-secondary">Dropbox is disconnected. An admin can connect it again.</p>
      );
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}
