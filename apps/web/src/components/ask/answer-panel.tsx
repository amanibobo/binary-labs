"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { cellLabel, citedSources, sourceNumber, type AnswerSentence, type AnswerSource, type Citation, type Verdict } from "@/lib/answers";
import { limitMessage, type AskState } from "@/lib/ask-state";
import { cn } from "@/lib/cn";
import { folderOf, openTarget } from "@/lib/format";
import { KIND_NAMES, protocolHref } from "@/lib/protocols";
import { suggestionHref, type SuggestRequest } from "@/lib/suggestions";
import { KindIcon } from "../files/kind-icon";
import { ProtocolIcon } from "../icons/drawn";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { useAskApi } from "./ask-api";

// The written answer above the search results: each sentence with the numbers of the sources
// it came from, those sources under it, and what to do next. While the reply streams, checked
// sentences appear one by one; when there's no answer, the closest files take its place.

// Where a citation opens: the file itself (or its table), or the protocol at the cited version.
export function citationHref(source: AnswerSource, citation: Citation | null): { href: string; external: boolean } {
  switch (source.kind) {
    case "protocol":
      return { href: protocolHref(source.protocolId, source.version), external: false };
    case "file": {
      if (citation?.cell != null) return { href: `/charts/new?file=${source.location.id}`, external: false };
      const open = openTarget(source.location);
      if (open !== null) return { href: open.href, external: source.location.sourceKind === "dropbox" };
      return { href: `/?${new URLSearchParams({ q: source.name, open: source.sha256 })}`, external: false };
    }
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function sourceTitle(source: AnswerSource): string {
  return source.kind === "file" ? source.name : source.title;
}

function Marks({ sentence, sources }: { sentence: AnswerSentence; sources: readonly AnswerSource[] }) {
  return (
    <>
      {sentence.citations.map((c) => {
        const source = sources.find((s) => s.key === c.source);
        const n = sourceNumber(sources, c.source);
        if (source === undefined || n === null) return null;
        const target = citationHref(source, c);
        const label = c.cell === null ? sourceTitle(source) : `${sourceTitle(source)}, ${cellLabel(c.cell)}: ${c.cell.value}`;
        return (
          <a
            key={`${c.source}-${c.cell?.table ?? ""}-${c.cell?.column ?? ""}-${c.cell?.row ?? ""}`}
            href={target.href}
            {...(target.external ? { target: "_blank", rel: "noreferrer" } : {})}
            title={label}
            aria-label={`Source ${n}: ${label}`}
            className="ml-0.5 inline-block rounded px-0.5 align-super text-[0.68em] leading-none font-medium text-content-accent tabular-nums hover:underline"
          >
            {n}
          </a>
        );
      })}
    </>
  );
}

export function AnswerText({ sentences, sources }: { sentences: readonly AnswerSentence[]; sources: readonly AnswerSource[] }) {
  return (
    <p className="max-w-prose text-paragraph-large text-content-primary">
      {sentences.map((s, i) => (
        <span key={i}>
          {i > 0 ? " " : null}
          {s.text}
          <Marks sentence={s} sources={sources} />
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
  numbered,
}: {
  sources: readonly AnswerSource[];
  sentences: readonly AnswerSentence[];
  // Answer sources keep their citation numbers; the closest files are a plain list.
  numbered: readonly AnswerSource[] | null;
}) {
  return (
    <ul className="mt-2 space-y-1">
      {sources.map((source) => {
        const n = numbered === null ? null : sourceNumber(numbered, source.key);
        const target = citationHref(source, null);
        const cells = citedCells(source, sentences);
        return (
          <li key={source.key}>
            <a
              href={target.href}
              {...(target.external ? { target: "_blank", rel: "noreferrer" } : {})}
              className="-mx-3 flex items-start gap-3 rounded-xl px-3 py-2 transition-colors duration-150 ease-out hover:bg-background-secondary focus-visible:outline-offset-[-2px]"
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

function readLine(sources: readonly AnswerSource[]): string {
  const files = sources.filter((s) => s.kind === "file").length;
  const protocols = sources.length - files;
  const parts = [files > 0 ? `${files} ${files === 1 ? "file" : "files"}` : null, protocols > 0 ? `${protocols} ${protocols === 1 ? "protocol" : "protocols"}` : null].filter(
    (p) => p !== null,
  );
  return `Read ${parts.join(" and ")}.`;
}

function Feedback({ verdict, onPick }: { verdict: Verdict | null; onPick: (v: Verdict) => void }) {
  const options: { value: Verdict; label: string }[] = [
    { value: "helpful", label: "Helpful" },
    { value: "not_helpful", label: "Not helpful" },
  ];
  return (
    <div role="group" aria-label="Was this answer helpful?" className="-mx-3 flex gap-1">
      {options.map((o) => (
        <Button
          key={o.value}
          variant={verdict === o.value ? "secondary" : "tertiary"}
          size="compact"
          aria-pressed={verdict === o.value}
          onClick={() => onPick(o.value)}
        >
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
    <div className="-mx-3 flex flex-wrap gap-1">
      {protocol?.kind === "protocol" ? (
        <Button
          variant="tertiary"
          size="compact"
          disabled={busy !== null}
          onClick={() => void run("protocol", { kind: "protocol_edit", protocolId: protocol.protocolId, questionId: state.questionId })}
        >
          {busy === "protocol" ? "Drafting an edit…" : `Suggest an edit to ${protocol.title}`}
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

export function AnswerPanel({
  state,
  onVerdict,
  onRetry,
}: {
  state: Exclude<AskState, { kind: "idle" }>;
  onVerdict: (verdict: Verdict) => void;
  onRetry: () => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} aria-busy={state.kind === "asking"} className="mb-10 px-3" data-testid="answer">
      <h2 id={headingId} className="mb-2 text-label-small text-content-tertiary">
        Answer
      </h2>
      <Body state={state} onRetry={onRetry} />
      {state.kind === "answered" ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border-opaque pt-3">
          <Feedback verdict={state.verdict} onPick={onVerdict} />
          {state.outcome === "answered" ? <SuggestActions state={state} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function Body({ state, onRetry }: { state: Exclude<AskState, { kind: "idle" }>; onRetry: () => void }) {
  switch (state.kind) {
    case "asking":
      return (
        <div aria-live="polite">
          {state.sentences.length > 0 ? (
            <AnswerText sentences={state.sentences} sources={state.sources ?? []} />
          ) : (
            <div className="max-w-prose space-y-2.5 pt-1.5" aria-hidden>
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}
          <p className="mt-3 text-paragraph-xsmall text-content-tertiary">
            {state.sources === null ? "Looking through the lab's records…" : state.sources.length === 0 ? "Nothing in the lab matches." : `${readLine(state.sources)} Writing the answer…`}
          </p>
        </div>
      );
    case "answered": {
      if (state.outcome === "not_found") return <NoAnswer sources={state.sources} message="The lab's records don't answer this." />;
      const cited = citedSources(state.sources, state.answer);
      return (
        <div aria-live="polite">
          <AnswerText sentences={state.answer.sentences} sources={cited} />
          <h3 className="mt-6 text-label-small text-content-tertiary">Sources</h3>
          <SourceList sources={cited} sentences={state.answer.sentences} numbered={cited} />
          <p className="mt-2 text-paragraph-xsmall text-content-tertiary">
            {readLine(state.sources)} Every sentence above cites one of them.
          </p>
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
      <SourceList sources={sources.slice(0, 5)} sentences={[]} numbered={null} />
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

