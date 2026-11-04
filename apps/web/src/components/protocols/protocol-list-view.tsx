"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import {
  authorName,
  KIND_NAMES,
  PROTOCOL_KINDS,
  protocolHref,
  type AuthorNames,
  type ProtocolKind,
  type ProtocolSummary,
} from "@/lib/protocols";
import { recordHref, type OpenTalkThrough } from "@/lib/talk-throughs";
import { MicIcon, ProtocolIcon } from "../icons/drawn";
import { OpenTalkThroughs } from "../talk-throughs/open-list";
import { buttonVariants } from "../ui/button";
import { dataRow, dataSurface } from "../ui/data-table";

type Filter = ProtocolKind | "all";

const FILTER_LABELS = { all: "All", protocol: "Protocols", tutorial: "Tutorials" } satisfies Record<Filter, string>;

export function ProtocolListView({
  protocols,
  authors,
  initialFilter,
  talkThroughs,
}: {
  protocols: ProtocolSummary[];
  authors: AuthorNames;
  initialFilter: Filter;
  // The viewer's recordings for new pages, waiting to be used.
  talkThroughs: readonly OpenTalkThrough[];
}) {
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const shown = filter === "all" ? protocols : protocols.filter((p) => p.kind === filter);

  function choose(next: Filter) {
    setFilter(next);
    const url = new URL(window.location.href);
    if (next === "all") url.searchParams.delete("kind");
    else url.searchParams.set("kind", next);
    window.history.replaceState(null, "", url);
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-8 pb-24 sm:px-8 sm:pt-16">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-heading-large">Protocols</h1>
          <p className="mt-1 max-w-prose text-paragraph-medium text-content-tertiary">
            How your lab does things, written down. Protocols hold the steps for an experiment; tutorials teach a tool or a
            technique.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={recordHref({ pageKind: filter === "tutorial" ? "tutorial" : "protocol" })} className={buttonVariants({ variant: "secondary" })}>
            <MicIcon className="size-5" />
            Record a talk-through
          </Link>
          <Link href="/protocols/new" className={buttonVariants()}>
            New page
          </Link>
        </div>
      </div>

      <OpenTalkThroughs items={talkThroughs} authors={authors} heading="Your talk-throughs" className="mt-8" />

      {protocols.length === 0 ? (
        <p className="mt-10 max-w-prose text-paragraph-medium text-content-secondary">
          No pages yet. Start one from scratch, or open a protocol document in Search and choose &ldquo;Make a protocol from
          this file&rdquo; to bring its text over.
        </p>
      ) : (
        <>
          <div role="group" aria-label="Show" className="mt-8 mb-4 flex gap-1">
            {(["all", ...PROTOCOL_KINDS] as const).map((option) => {
              const count = option === "all" ? protocols.length : protocols.filter((p) => p.kind === option).length;
              const selected = filter === option;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => choose(option)}
                  className={cn(
                    buttonVariants({ variant: selected ? "secondary" : "tertiary", size: "compact" }),
                    !selected && "text-content-secondary",
                  )}
                >
                  {FILTER_LABELS[option]}
                  <span className="text-content-tertiary tabular-nums">{count}</span>
                </button>
              );
            })}
          </div>
          {shown.length === 0 ? (
            <p className="pt-2 text-paragraph-medium text-content-secondary">
              No {filter === "tutorial" ? "tutorials" : "protocols"} yet.
            </p>
          ) : (
            <ul className={dataSurface}>
              {shown.map((p) => (
                <li key={p.id} className={cn(dataRow, "hover:bg-background-secondary")}>
                  <Link href={protocolHref(p.id)} className="flex min-h-16 items-start gap-4 py-4 pr-4 pl-4 sm:pr-5 sm:pl-5">
                    <ProtocolIcon className="mt-0.5 text-content-secondary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-label-medium text-content-primary">{p.title}</span>
                      <span className="mt-1 block text-paragraph-small text-content-tertiary">
                        {KIND_NAMES[p.kind]} · Version {p.version} · Updated {formatDate(p.updatedAt)} by{" "}
                        {authorName(authors, p.author)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
