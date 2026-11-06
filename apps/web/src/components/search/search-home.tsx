"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { DROPBOX_FOLDER_HREF, settingsHref } from "@/app/settings/sections";
import type { FileHit, SearchFilters } from "@/lib/domain";
import { exampleQueries } from "@/lib/example-queries";
import { hasFilters, matchesFilters } from "@/lib/filters";
import type { Sha256 } from "@/lib/ids";
import type { LabLists } from "@/lib/label-edit";
import { hasIndex, type SourceState } from "@/lib/source-state";
import { cn } from "@/lib/cn";
import { looksLikeQuestion } from "@/lib/answers";
import { QuestionId } from "@/lib/ids";
import { AnswerPanel, AskRow } from "../ask/answer-panel";
import { RecentQuestions, useAsk, type AskHome } from "../ask/ask-home";
import { GettingStartedCard } from "../onboarding/getting-started";
import { useOnboarding } from "../onboarding/onboarding-context";
import { LabelsProvider, LabListsProvider, useLabelPolling } from "../labels/labels-context";
import { ActiveScan } from "../scan-status";
import { buttonVariants } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { ProtocolResults } from "../protocols/protocol-results";
import { FileResult } from "./file-result";
import { Filters, FiltersToggle } from "./filters";
import { SearchBox } from "./search-box";
import { useFileSearch } from "./use-file-search";

export function SearchHome({
  recent,
  source,
  isAdmin,
  lists,
  ask,
}: {
  recent: FileHit[];
  source: SourceState;
  isAdmin: boolean;
  lists: LabLists;
  // Asking the lab; left out, the page is search alone.
  ask?: AskHome;
}) {
  const params = useSearchParams();
  const urlQuery = params.get("q") ?? "";
  const urlOpen = params.get("open");
  const [query, setQuery] = useState(urlQuery);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(urlOpen);
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const { markDone } = useOnboarding();
  const asking = useAsk();
  const { open: openAnswer } = asking;

  // ?ask=<question> reopens a saved answer, as a reload or a shared link does.
  const urlAsk = params.get("ask");
  useEffect(() => {
    const id = QuestionId.safeParse(urlAsk);
    if (id.success) openAnswer(id.data);
    // Only the address the page opened with; later changes come from this page itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The palette navigates here with ?q=…&open=…; follow it (set during render, per React's guidance).
  const [seenUrl, setSeenUrl] = useState({ q: urlQuery, open: urlOpen });
  if (seenUrl.q !== urlQuery || seenUrl.open !== urlOpen) {
    setSeenUrl({ q: urlQuery, open: urlOpen });
    if (query.trim() !== urlQuery.trim()) setQuery(urlQuery);
    if (urlOpen !== null) setExpanded(urlOpen);
  }

  function updateQuery(next: string) {
    setQuery(next);
    if (asking.state.kind !== "idle" && next.trim() !== asking.state.question.trim()) asking.close();
    if (next.trim() !== "") markDone("searchedAt");
    const url = new URL(window.location.href);
    if (next.trim() === "") url.searchParams.delete("q");
    else url.searchParams.set("q", next);
    url.searchParams.delete("open");
    window.history.replaceState(null, "", url);
  }

  const search = useFileSearch(query, filters);
  const searching = query.trim().length > 0;
  const toggle = (sha: Sha256) => setExpanded((current) => (current === sha ? null : sha));
  const indexed = hasIndex(source);
  const headingId = `${inputId}-results`;
  const askedThis = asking.state.kind !== "idle" && asking.state.question.trim() === query.trim();
  const offerAsk = ask !== undefined && searching && looksLikeQuestion(query) && !askedThis;
  const startAsk = () => {
    if (ask?.available === true && looksLikeQuestion(query)) asking.ask(query.trim());
  };
  const filtersId = `${inputId}-filters`;

  return (
    <LabListsProvider value={lists}>
      <LabelsProvider>
        <div className="mx-auto w-full max-w-3xl px-4 pt-4 pb-24 sm:px-8 sm:pt-20">
          <ActiveScan initial={source} />
          <h1 className="sr-only">Search</h1>
          <label htmlFor={inputId} className="sr-only">
            Search your lab&apos;s files
          </label>
          <SearchBox
            ref={input}
            id={inputId}
            value={query}
            onChange={(e) => updateQuery(e.target.value)}
            placeholder="Find a file, a gel, a protocol…"
            autoFocus
            data-tour="search-box"
            onKeyDown={(e) => {
              if (e.key === "Enter" && offerAsk) {
                e.preventDefault();
                startAsk();
              }
            }}
            end={indexed ? <FiltersToggle open={filtersOpen} onToggle={() => setFiltersOpen((o) => !o)} controls={filtersId} /> : undefined}
          />
          {indexed ? <Filters id={filtersId} open={filtersOpen} value={filters} onChange={setFilters} /> : null}
          {indexed && !searching ? (
            <Examples
              queries={exampleQueries(recent, lists)}
              onPick={(example) => {
                updateQuery(example);
                input.current?.focus();
              }}
            />
          ) : null}
          {offerAsk ? <AskRow question={query} available={ask.available} onAsk={startAsk} className="mt-2" /> : null}
          {searching ? null : <GettingStartedCard className="mt-8 sm:mt-10" />}

          <section aria-labelledby={headingId} className="-mx-3 mt-8 sm:mt-10">
            {asking.state.kind !== "idle" && askedThis ? (
              <AnswerPanel
                key={asking.round}
                state={asking.state}
                onClose={() => {
                  asking.close();
                  input.current?.focus();
                }}
                onRetry={() => asking.ask(query.trim())}
                onVerdict={(verdict) => {
                  if (asking.state.kind === "answered") asking.verdict(asking.state.questionId, verdict);
                }}
              />
            ) : null}
            {!searching && ask !== undefined ? (
              <RecentQuestions
                home={ask}
                onOpen={(q) => {
                  updateQuery(q.question);
                  asking.open(q.id);
                }}
              />
            ) : null}
            {searching ? (
              <SearchResults search={search} query={search.settledQuery} expanded={expanded} onToggle={toggle} headingId={headingId} filtered={hasFilters(filters)} />
            ) : (
              <RecentFiles
                recent={recent.filter((hit) => matchesFilters(hit, filters))}
                source={source}
                isAdmin={isAdmin}
                filtered={hasFilters(filters)}
                expanded={expanded}
                onToggle={toggle}
                headingId={headingId}
              />
            )}
          </section>
        </div>
      </LabelsProvider>
    </LabListsProvider>
  );
}

// A few searches in the lab's own words; picking one runs it.
function Examples({ queries, onPick }: { queries: string[]; onPick: (query: string) => void }) {
  if (queries.length === 0) return null;
  return (
    // One line: phones scroll it sideways instead of wrapping into a second row.
    <div className="-mx-4 mt-3 flex items-center gap-x-1 overflow-x-auto px-4 text-paragraph-small whitespace-nowrap [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
      <span className="mr-1 shrink-0 text-content-tertiary">Try</span>
      {queries.map((example) => (
        <button
          key={example}
          type="button"
          onClick={() => onPick(example)}
          className="min-h-11 shrink-0 rounded-control px-2 text-content-secondary transition-colors duration-150 ease-out hover:bg-background-secondary hover:text-content-primary sm:min-h-8"
        >
          {example}
        </button>
      ))}
    </div>
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
  const { data, isError, isPlaceholderData, refetch } = search;
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
  // With protocols above, the count below says what it counts.
  const noun = data.protocols.length > 0 ? ["file", "files"] : ["result", "results"];
  return (
    // While the next query loads the last results stay, fading only if it takes a moment.
    <div data-stale={isPlaceholderData} className="transition-opacity duration-200 ease-out data-[stale=true]:opacity-60 data-[stale=true]:delay-300">
      <ProtocolResults hits={data.protocols} query={query} />
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3">
        <h2 id={headingId} className="text-label-small text-content-tertiary" aria-live="polite">
          {count === 0 ? `No ${noun[1]}` : count === 1 ? `1 ${noun[0]}` : `${count} ${noun[1]}`}
        </h2>
        {data.kind === "keyword" ? <p className="text-paragraph-xsmall text-content-tertiary">Showing exact word matches only right now.</p> : null}
      </div>
      {count === 0 ? (
        <p className="px-3 pt-2 text-paragraph-medium text-content-secondary">
          {data.protocols.length > 0 ? "No files match" : "Nothing matches"} &ldquo;{query}&rdquo;{filtered ? " with these filters" : ""}.
        </p>
      ) : (
        <ul data-tour="results" className="space-y-1">
          {data.results.map((hit) => (
            <FileResult key={hit.sha256} hit={hit} query={query} expanded={expanded === hit.sha256} onToggle={() => onToggle(hit.sha256)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchError({ headingId, onRetry }: { headingId: string; onRetry: () => void }) {
  return (
    <div className="px-3">
      <h2 id={headingId} className="text-paragraph-medium text-content-primary">
        Search isn&apos;t working right now.
      </h2>
      <button type="button" onClick={onRetry} className={cn(buttonVariants({ variant: "secondary" }), "mt-3")}>
        Try again
      </button>
    </div>
  );
}

// The row's shape: a preview square, a name, the meta line and a line of matching text.
function ResultSkeleton() {
  return (
    <div className="grid gap-1" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-start gap-4 p-3">
          <Skeleton className="size-14 shrink-0 sm:size-16" />
          <div className="flex-1 space-y-2.5 pt-1">
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
      <div className="px-3">
        <h2 id={headingId} className={hasIndex(source) ? "mb-2 text-label-small text-content-tertiary" : "sr-only"}>
          Recent files
        </h2>
        <EmptyLab source={source} isAdmin={isAdmin} filtered={filtered} />
      </div>
    );
  }
  return (
    <>
      <h2 id={headingId} className="mb-1 px-3 text-label-small text-content-tertiary">
        Recent files
      </h2>
      <ul data-tour="results" className="space-y-1">
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
            Connect your lab&apos;s Dropbox to start. Binary reads one folder and never changes a file.
          </p>
          <Link href={settingsHref("dropbox")} className={cn(buttonVariants(), "mt-4")}>
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
          <Link href={DROPBOX_FOLDER_HREF} className={cn(buttonVariants(), "mt-4")}>
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
          <Link href={settingsHref("dropbox")} className={cn(buttonVariants(), "mt-4")}>
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
