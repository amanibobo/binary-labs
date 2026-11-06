"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { cellLabel, citedSources, type AnswerSentence, type AnswerSource, type SourceKey, type Verdict } from "@/lib/answers";
import { limitMessage, type AskState } from "@/lib/ask-state";
import { cn } from "@/lib/cn";
import { folderOf } from "@/lib/format";
import { KIND_NAMES } from "@/lib/protocols";
import { suggestionHref, type SuggestRequest } from "@/lib/suggestions";
import { KindIcon } from "../files/kind-icon";
import { DeleteIcon } from "../icons/base-web";
import { ProtocolIcon } from "../icons/drawn";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { AskActivity, CitationLinkProvider, pointProps, useCitationLink, useRevealedSteps, type WriteOutcome } from "./ask-activity";
import { useAskApi } from "./ask-api";
import { citationHref } from "./citation-href";

// The answer box above the search results: its own surface, so an answer never reads as one
// more result. At the top, the work behind it as it happens (ask-activity.tsx); then the
// answer, each sentence followed by the numbers of the sources it came from, those sources
// under it, and what to do next in the footer. When there's no answer, the closest files take
// its place.

function sourceTitle(source: AnswerSource): string {
  return source.kind === "file" ? source.name : source.title;
}

function Marks({ sentence, sources, numbers }: { sentence: AnswerSentence; sources: readonly AnswerSource[]; numbers: ReadonlyMap<SourceKey, number> }) {
  const link = useCitationLink();
  return (
    <>
      {sentence.citations.map((c) => {
        const source = sources.find((s) => s.key === c.source);
        const n = numbers.get(c.source);
        if (source === undefined || n === undefined) return null;
        const target = citationHref(source, c);
        const label = c.cell === null ? sourceTitle(source) : `${sourceTitle(source)}, ${cellLabel(c.cell)}: ${c.cell.value}`;
        const lit = link.key === c.source;
        return (
          <a
            key={`${c.source}-${c.cell?.table ?? ""}-${c.cell?.column ?? ""}-${c.cell?.row ?? ""}`}
            href={target.href}
            {...(target.external ? { target: "_blank", rel: "noreferrer" } : {})}
            title={label}
            aria-label={`Source ${n}: ${label}`}
            data-lit={lit}
            className={cn(
              "ml-0.5 inline-block min-w-[1.4em] rounded px-0.5 text-center align-super text-[0.68em] leading-[1.35] font-medium text-content-accent tabular-nums transition-colors duration-150 ease-out hover:underline",
              lit && "bg-tag-blue-background-secondary text-tag-blue-content-secondary",
            )}
            {...pointProps(link, c.source)}
          >
            {n}
          </a>
        );
      })}
    </>
  );
}

export function AnswerText({
  sentences,
  sources,
  numbers,
}: {
  sentences: readonly AnswerSentence[];
  sources: readonly AnswerSource[];
  numbers: ReadonlyMap<SourceKey, number>;
}) {
  return (
    <p className="max-w-prose text-paragraph-large text-content-primary">
      {sentences.map((s, i) => (
        <span key={i} className="animate-fade-in">
          {i > 0 ? " " : null}
          {s.text}
          <Marks sentence={s} sources={sources} numbers={numbers} />
        </span>
      ))}
    </p>
  );
}

// The cells of this source the answer cites, said in words.
function citedCells(source: AnswerSource, sentences: readonly AnswerSentence[]): string[] {
  const out = new Set<string>();
  for (const s of sentences) for (const c of s.citations) if (c.source === source.key && c.cell !== null) out.add(`${cellLabel(c.cell)}: ${c.cell.value}`);
  return [...out];
}

export function SourceList({
  sources,
  sentences,
  numbers,
}: {
  sources: readonly AnswerSource[];
  sentences: readonly AnswerSentence[];
  // Answer sources keep their citation numbers; the closest files are a plain list.
  numbers: ReadonlyMap<SourceKey, number> | null;
}) {
  const link = useCitationLink();
  return (
    <ul className="mt-2 space-y-1">
      {sources.map((source) => {
        const n = numbers?.get(source.key) ?? null;
        const target = citationHref(source, null);
        const cells = citedCells(source, sentences);
        const lit = n !== null && link.key === source.key;
        return (
          <li key={source.key}>
            <a
              href={target.href}
              {...(target.external ? { target: "_blank", rel: "noreferrer" } : {})}
              data-lit={lit}
              className={cn(
                "-mx-3 flex items-start gap-3 rounded-xl px-3 py-2 transition-colors duration-150 ease-out hover:bg-background-secondary focus-visible:outline-offset-[-2px]",
                lit && "bg-background-secondary",
              )}
              {...(n === null ? {} : pointProps(link, source.key))}
            >
              {n === null ? null : <span className="w-4 shrink-0 pt-0.5 text-right text-label-small text-content-tertiary tabular-nums">{n}</span>}
              <span className="shrink-0 pt-0.5">
                {source.kind === "file" ? <KindIcon kind={source.fileKind} className="size-5" /> : <ProtocolIcon className="size-5 text-content-secondary" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label-medium text-content-primary">{sourceTitle(source)}</span>
                <span className="mt-0.5 block truncate text-paragraph-xsmall text-content-tertiary">
                  {source.kind === "file" ? <span className="font-mono">{folderOf(source.location)}</span> : `${KIND_NAMES[source.protocolKind]} · Version ${source.version}`}
                </span>
                {cells.map((cell) => (
                  <span key={cell} className="mt-0.5 block text-paragraph-small text-content-secondary">
                    {cell}
                  </span>
                ))}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function Feedback({ verdict, onPick }: { verdict: Verdict | null; onPick: (v: Verdict) => void }) {
  const options: { value: Verdict; label: string }[] = [
    { value: "helpful", label: "Helpful" },
    { value: "not_helpful", label: "Not helpful" },
  ];
  return (
    <div role="group" aria-label="Was this answer helpful?" className="-mx-3 flex gap-1">
      {options.map((o) => (
        <Button key={o.value} variant={verdict === o.value ? "secondary" : "tertiary"} size="compact" aria-pressed={verdict === o.value} onClick={() => onPick(o.value)}>
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function SuggestActions({ state }: { state: Extract<AskState, { kind: "answered" }> }) {
  const api = useAskApi();
  const router = useRouter();
  const [busy, setBusy] = useState<"protocol" | "labels" | null>(null);
  const cited = citedSources(state.sources, state.answer);
  const protocol = cited.find((s) => s.kind === "protocol") ?? state.sources.find((s) => s.kind === "protocol");
  const hasFiles = state.sources.some((s) => s.kind === "file");

  async function run(which: "protocol" | "labels", req: SuggestRequest) {
    setBusy(which);
    try {
      const outcome = await api.suggest(req);
      switch (outcome.kind) {
        case "created":
          router.push(suggestionHref(outcome.id));
          return;
        case "none":
        case "limit":
          toast(outcome.message);
          break;
        default: {
          const _exhaustive: never = outcome;
          return _exhaustive;
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't draft a suggestion.");
    }
    setBusy(null);
  }

  return (
    <div className="-mx-3 flex min-w-0 flex-wrap gap-1">
      {protocol?.kind === "protocol" ? (
        <Button
          variant="tertiary"
          size="compact"
          className="max-w-full min-w-0"
          disabled={busy !== null}
          onClick={() => void run("protocol", { kind: "protocol_edit", protocolId: protocol.protocolId, questionId: state.questionId })}
        >
          <span className="truncate">{busy === "protocol" ? "Drafting an edit…" : `Suggest an edit to ${protocol.title}`}</span>
        </Button>
      ) : null}
      {hasFiles ? (
        <Button variant="tertiary" size="compact" disabled={busy !== null} onClick={() => void run("labels", { kind: "labels", questionId: state.questionId })}>
          {busy === "labels" ? "Checking labels…" : "Suggest label fixes"}
        </Button>
      ) : null}
    </div>
  );
}

function writeOutcome(state: Exclude<AskState, { kind: "idle" }>): WriteOutcome {
  switch (state.kind) {
    case "asking":
      return "live";
    case "answered":
      return state.outcome;
    case "limit":
    case "failed":
      return "stopped";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function sentencesOf(state: Exclude<AskState, { kind: "idle" }>): readonly AnswerSentence[] {
  if (state.kind === "asking") return state.sentences;
  if (state.kind === "answered") return state.answer.sentences;
  return [];
}

export function AnswerPanel({
  state,
  onVerdict,
  onRetry,
  onClose,
}: {
  state: Exclude<AskState, { kind: "idle" }>;
  onVerdict: (verdict: Verdict) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const headingId = useId();
  const [pointed, point] = useState<SourceKey | null>(null);
  const live = state.kind === "asking";
  const shown = useRevealedSteps(state.steps.length, live);
  const caughtUp = shown >= state.steps.length;
  const sentences = sentencesOf(state);
  // Numbered in the order the answer first cites them, so a number holds while sentences stream.
  const cited = citedSources(state.sources ?? [], { sentences: [...sentences] });
  const numbers = new Map(cited.map((s, i) => [s.key, i + 1]));
  return (
    <CitationLinkProvider value={{ key: pointed, point }}>
      <section
        aria-labelledby={headingId}
        aria-busy={live}
        data-testid="answer"
        className="mx-3 mb-10 rounded-card border border-border-opaque bg-background-raised shadow-raised sm:mx-0"
      >
        <header className="flex items-center justify-between gap-3 py-2 pr-2 pl-4 sm:pl-6">
          <h2 id={headingId} className="text-label-small text-content-secondary">
            Answer from the lab&apos;s files
          </h2>
          <Button variant="tertiary" size="compact" shape="square" aria-label="Close the answer" onClick={onClose}>
            <DeleteIcon className="size-5 text-content-tertiary" />
          </Button>
        </header>
        <div className="px-4 pb-5 sm:px-6 sm:pb-6">
          <AskActivity steps={state.steps.slice(0, shown)} live={live} outcome={writeOutcome(state)} sources={state.sources} numbers={numbers} />
          <Body state={state} caughtUp={caughtUp} cited={cited} numbers={numbers} onRetry={onRetry} />
        </div>
        {state.kind === "answered" ? (
          <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border-opaque px-4 py-2 sm:px-6">
            <Feedback verdict={state.verdict} onPick={onVerdict} />
            {state.outcome === "answered" ? <SuggestActions state={state} /> : null}
          </footer>
        ) : null}
      </section>
    </CitationLinkProvider>
  );
}

function Body({
  state,
  caughtUp,
  cited,
  numbers,
  onRetry,
}: {
  state: Exclude<AskState, { kind: "idle" }>;
  // Whether every step so far is on screen; the answer waits for the steps above it.
  caughtUp: boolean;
  cited: readonly AnswerSource[];
  numbers: ReadonlyMap<SourceKey, number>;
  onRetry: () => void;
}) {
  switch (state.kind) {
    case "asking": {
      const writing = state.steps.some((s) => s.kind === "write");
      if (!caughtUp || !writing) return null;
      return (
        <div aria-live="polite" className="mt-2">
          {state.sentences.length > 0 ? (
            <AnswerText sentences={state.sentences} sources={state.sources ?? []} numbers={numbers} />
          ) : (
            <div className="max-w-prose animate-fade-in space-y-2.5 pt-1.5" aria-hidden>
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}
        </div>
      );
    }
    case "answered": {
      if (state.outcome === "not_found") return <NoAnswer sources={state.sources} message="The lab's records don't answer this." />;
      return (
        <div aria-live="polite">
          <AnswerText sentences={state.answer.sentences} sources={cited} numbers={numbers} />
          <h3 className="mt-6 text-label-small text-content-tertiary">Sources</h3>
          <SourceList sources={cited} sentences={state.answer.sentences} numbers={numbers} />
        </div>
      );
    }
    case "limit":
      return <NoAnswer sources={state.sources} message={limitMessage(state.budget)} />;
    case "failed":
      return (
        <div>
          <p className="text-paragraph-medium text-content-primary">{state.message}</p>
          <Button variant="secondary" size="compact" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
          {state.sources.length > 0 ? <ClosestFiles sources={state.sources} /> : null}
        </div>
      );
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function NoAnswer({ sources, message }: { sources: readonly AnswerSource[]; message: string }) {
  return (
    <div>
      <p className="max-w-prose text-paragraph-large text-content-primary">{message}</p>
      {sources.length > 0 ? <ClosestFiles sources={sources} /> : <p className="mt-2 text-paragraph-small text-content-secondary">Nothing in the lab came close.</p>}
    </div>
  );
}

function ClosestFiles({ sources }: { sources: readonly AnswerSource[] }) {
  return (
    <>
      <h3 className="mt-6 text-label-small text-content-tertiary">Closest files</h3>
      <SourceList sources={sources.slice(0, 5)} sentences={[]} numbers={null} />
    </>
  );
}

// The row under the search box that turns a question into an answer.
export function AskRow({ question, available, onAsk, className }: { question: string; available: boolean; onAsk: () => void; className?: string }) {
  if (!available) {
    return <p className={cn("text-paragraph-small text-content-tertiary", className)}>Asking questions isn&apos;t set up here yet, so these are search results.</p>;
  }
  return (
    <button
      type="button"
      onClick={onAsk}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-paragraph-medium text-content-secondary transition-colors duration-150 ease-out hover:bg-background-secondary hover:text-content-primary",
        className,
      )}
    >
      <span className="text-label-medium text-content-primary">Ask the lab</span>
      <span className="min-w-0 flex-1 truncate">&ldquo;{question.trim()}&rdquo;</span>
      <kbd className="hidden shrink-0 font-sans text-paragraph-xsmall text-content-tertiary sm:inline">Enter</kbd>
    </button>
  );
}
