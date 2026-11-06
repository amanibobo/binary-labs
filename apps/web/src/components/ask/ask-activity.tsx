"use client";

import { createContext, use, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AnswerSource, AskStep, SourceKey } from "@/lib/answers";
import { activityRows, activitySummary, searchResultWords, tableWords, type ActivityRow } from "@/lib/ask-state";
import { cn } from "@/lib/cn";
import { KindIcon } from "../files/kind-icon";
import { citationHref } from "./citation-href";
import { CheckIcon, ChevronRightIcon, SearchIcon } from "../icons/base-web";
import { FileIcon, ProtocolIcon, TableIcon, WritingIcon } from "../icons/drawn";

// The work behind an answer, as it happens: the search, then the files, protocols and tables
// it read, then the writing. Every row is a step the server reported; none is made up here.
// Once the answer is in, the list folds into one line that opens it again.

// --- The citation a person is pointing at, shared by the numbers in the answer and the chips ---

type CitationLink = { key: SourceKey | null; point: (key: SourceKey | null) => void };
const CitationLinkContext = createContext<CitationLink>({ key: null, point: () => undefined });
export const CitationLinkProvider = CitationLinkContext.Provider;

export function useCitationLink(): CitationLink {
  return use(CitationLinkContext);
}

// Pointing at a source, by mouse or keyboard, lights everything that names it.
export function pointProps(link: CitationLink, key: SourceKey) {
  return {
    onMouseEnter: () => link.point(key),
    onMouseLeave: () => link.point(null),
    onFocus: () => link.point(key),
    onBlur: () => link.point(null),
  };
}

// --- Steps arriving in a burst still appear one after another ---

// Retrieval often reports every file, protocol and table within a few milliseconds. Rows are
// shown at most this far apart so each can be read arriving; nothing else is delayed.
export const STEP_STAGGER_MS = 45;

const reducedMotion = "(prefers-reduced-motion: reduce)";
function subscribeMotion(onChange: () => void) {
  const query = window.matchMedia(reducedMotion);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(reducedMotion).matches,
    () => false,
  );
}

// How many of `total` steps to show now. `live` is false for work that's already over (an
// answer opened again), which shows everything at once, as reduced motion does.
export function useRevealedSteps(total: number, live: boolean): number {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(0);
  const instant = !live || reduced;
  useEffect(() => {
    if (instant || shown >= total) return;
    const id = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 0 : STEP_STAGGER_MS);
    return () => clearTimeout(id);
  }, [instant, shown, total]);
  return instant ? total : Math.min(shown, total);
}

// --- The list ---

// What became of the writing, for its row once the work is over.
export type WriteOutcome = "live" | "answered" | "not_found" | "stopped";

export function AskActivity({
  steps,
  live,
  outcome,
  sources,
  numbers,
}: {
  steps: readonly AskStep[];
  live: boolean;
  outcome: WriteOutcome;
  // Null until retrieval has handed them over; chips link to their source once it has.
  sources: readonly AnswerSource[] | null;
  // The citation number of each source the answer cites.
  numbers: ReadonlyMap<SourceKey, number>;
}) {
  const [opened, setOpened] = useState(false);
  const listId = useId();
  const open = live || opened;
  if (steps.length === 0) return null;
  const cached = steps.some((s) => s.kind === "write" && s.cached);
  return (
    <div className="mb-4" data-testid="ask-activity">
      {live ? null : (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpened((o) => !o)}
          className="-mx-2 flex min-h-11 max-w-full items-center gap-1.5 rounded-control px-2 py-1.5 text-left text-paragraph-small text-content-secondary transition-colors duration-150 ease-out hover:bg-background-secondary hover:text-content-primary sm:min-h-8"
        >
          <ChevronRightIcon className={cn("size-4 text-content-tertiary transition-transform duration-200 ease-out", open && "rotate-90")} />
          <span className="min-w-0">
            {activitySummary(steps)}
            {cached ? " · answered before" : ""}
          </span>
        </button>
      )}
      <div
        id={listId}
        inert={!open}
        className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
      >
        <ol aria-label="What the answer read" aria-live={live ? "polite" : undefined} className={cn("min-h-0 overflow-hidden", !live && "pt-1")}>
          {activityRows(steps).map((row) => (
            <Row key={rowKey(row)} row={row} live={live} outcome={outcome} sources={sources} numbers={numbers} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function rowKey(row: ActivityRow): string {
  switch (row.kind) {
    case "search":
    case "write":
      return `${row.kind}-${row.step.id}`;
    case "file":
    case "protocol":
    case "table":
      return `${row.kind}-${row.steps[0]?.id ?? 0}`;
    default: {
      const _exhaustive: never = row;
      return _exhaustive;
    }
  }
}

function Row({
  row,
  live,
  outcome,
  sources,
  numbers,
}: {
  row: ActivityRow;
  live: boolean;
  outcome: WriteOutcome;
  sources: readonly AnswerSource[] | null;
  numbers: ReadonlyMap<SourceKey, number>;
}) {
  const source = (key: SourceKey) => sources?.find((s) => s.key === key) ?? null;
  switch (row.kind) {
    case "search": {
      const { query, found } = row.step;
      return (
        <StepLine icon={<SearchIcon />} animate>
          <span className="min-w-0 text-content-secondary">
            {found === null ? "Searching the lab for " : "Searched the lab for "}
            <span className="text-content-primary">&ldquo;{query}&rdquo;</span>
          </span>
          {found === null ? (
            live ? <Spinner label="Searching" /> : null
          ) : (
            <Result>
              {searchResultWords(found)}
              {found.byMeaning ? "" : ", by matching words"}
            </Result>
          )}
        </StepLine>
      );
    }
    case "file":
      return (
        <StepLine icon={<FileIcon />}>
          <ReadLabel />
          {row.steps.map((s) => (
            <SourceChip key={s.id} sourceKey={s.source} source={source(s.source)} number={numbers.get(s.source) ?? null} icon={<KindIcon kind={s.fileKind} className="size-4" />} label={s.name} />
          ))}
        </StepLine>
      );
    case "protocol":
      return (
        <StepLine icon={<ProtocolIcon />}>
          <ReadLabel />
          {row.steps.map((s) => (
            <SourceChip
              key={s.id}
              sourceKey={s.source}
              source={source(s.source)}
              number={numbers.get(s.source) ?? null}
              icon={<ProtocolIcon className="size-4 text-content-secondary" />}
              label={s.title}
              detail={`v${s.version}`}
            />
          ))}
        </StepLine>
      );
    case "table":
      return (
        <StepLine icon={<TableIcon />}>
          <ReadLabel />
          {row.steps.map((s) => (
            <SourceChip
              key={s.id}
              sourceKey={s.source}
              source={source(s.source)}
              number={null}
              icon={<TableIcon className="size-4 text-content-secondary" />}
              label={s.sheet}
              detail={tableWords(s)}
              table
            />
          ))}
        </StepLine>
      );
    case "write": {
      if (row.step.cached) {
        return (
          <StepLine icon={<WritingIcon />} animate>
            <span className="text-content-secondary">Answered before from these same files</span>
            <Result>Saved answer</Result>
          </StepLine>
        );
      }
      const words: Record<WriteOutcome, string> = {
        live: "Writing the answer",
        answered: "Wrote the answer",
        not_found: "Looked for the answer in them",
        stopped: "Stopped before the answer was done",
      };
      return (
        <StepLine icon={<WritingIcon />} animate>
          <span className="text-content-secondary">{words[outcome]}</span>
          {outcome === "live" ? <Spinner label="Writing" /> : outcome === "answered" ? <Result /> : outcome === "not_found" ? <Result>No answer</Result> : null}
        </StepLine>
      );
    }
    default: {
      const _exhaustive: never = row;
      return _exhaustive;
    }
  }
}

function StepLine({ icon, animate = false, children }: { icon: ReactNode; animate?: boolean; children: ReactNode }) {
  return (
    <li className={cn("flex items-start gap-3 py-1", animate && "animate-step-in")}>
      <span className="flex h-7 w-5 shrink-0 items-center justify-center text-content-tertiary [&>svg]:size-[18px]" aria-hidden>
        {icon}
      </span>
      <div className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-paragraph-small">{children}</div>
    </li>
  );
}

function ReadLabel() {
  return <span className="animate-step-in text-content-secondary">Read</span>;
}

function Result({ children }: { children?: ReactNode }) {
  return (
    <span className="inline-flex animate-step-in items-center gap-1 text-content-tertiary">
      <CheckIcon className="size-4" />
      {children}
    </span>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <span role="status" aria-label={label} className="inline-flex size-4 items-center justify-center">
      <span className="size-3.5 animate-spin rounded-full border-[1.5px] border-border-raised border-t-content-secondary" />
    </span>
  );
}

// A file, protocol or table the answer read. It opens what it names once the sources are in,
// and lights up with the citation numbers that point at it.
function SourceChip({
  sourceKey,
  source,
  number,
  icon,
  label,
  detail,
  table = false,
}: {
  sourceKey: SourceKey;
  source: AnswerSource | null;
  number: number | null;
  icon: ReactNode;
  label: string;
  detail?: string;
  // A table chip lights with its file, but carries no number of its own.
  table?: boolean;
}) {
  const link = useCitationLink();
  const lit = link.key === sourceKey && (number !== null || table);
  const className = cn(
    "inline-flex h-7 max-w-full animate-step-in items-center gap-1.5 rounded-control border px-2 text-label-xsmall text-content-primary transition-colors duration-150 ease-out",
    lit ? "border-border-selected bg-background-secondary" : "border-border-opaque bg-background-primary",
  );
  const body = (
    <>
      {number === null ? null : <span className="text-content-tertiary tabular-nums">{number}</span>}
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      {detail === undefined ? null : <span className="shrink-0 font-normal text-content-tertiary">{detail}</span>}
    </>
  );
  if (source === null) return <span className={className}>{body}</span>;
  const target = citationHref(source, null);
  return (
    <a
      href={target.href}
      {...(target.external ? { target: "_blank", rel: "noreferrer" } : {})}
      data-lit={lit}
      className={cn(className, "hover:bg-background-secondary focus-visible:outline-offset-1")}
      {...pointProps(link, sourceKey)}
    >
      {body}
    </a>
  );
}
