"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { KIND_NAMES, protocolHref, type AuthorNames, authorName } from "@/lib/protocols";
import { formatClock, isSettled, recordHref, talkThroughHref, type TalkThrough, type TalkThroughStatus } from "@/lib/talk-throughs";
import { useLabApi } from "../lab-api";
import { CrumbBar } from "../protocols/crumb-bar";
import { Markdown } from "../protocols/markdown";
import { Button, buttonVariants } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { When } from "@/components/ui/when";

const POLL_MS = 2_000;

export function TalkThroughView({ initial, authors }: { initial: TalkThrough; authors: AuthorNames }) {
  const api = useLabApi();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["talk-through", initial.id],
    queryFn: ({ signal }) => api.talkThrough(initial.id, signal),
    initialData: initial,
    refetchInterval: (q) => (q.state.data !== undefined && isSettled(q.state.data.status) ? false : POLL_MS),
  });
  const tt = query.data;
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      await api.retryTalkThrough(tt.id);
      await queryClient.invalidateQueries({ queryKey: ["talk-through", tt.id] });
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : "We couldn't retry that. Try again.");
    } finally {
      setRetrying(false);
    }
  }

  const status = tt.status;
  const heading = status.kind === "ready" ? status.title : "Talk-through";
  const pageLabel = tt.page === null ? `a new ${KIND_NAMES[tt.kind].toLowerCase()}` : tt.page.title;

  return (
    <>
      <CrumbBar
        items={[
          tt.page === null ? { label: "New protocol", href: "/protocols/new" } : { label: tt.page.title, href: protocolHref(tt.page.protocolId) },
          { label: "Talk-through", href: talkThroughHref(tt.id) },
        ]}
        width="max-w-6xl sm:px-6"
      />
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-24 sm:px-6 sm:pt-12">
        <h1 className="text-heading-medium sm:text-heading-large">{heading}</h1>
        <p className="mt-2 text-paragraph-small text-content-tertiary">
          For {pageLabel} · Recorded <When iso={tt.recordedAt} /> by {authorName(authors, tt.recordedBy)}
          {tt.durationMs === null ? "" : ` · ${formatClock(tt.durationMs)}`}
        </p>

        <Progress status={status} />

        <NextStep tt={tt} retrying={retrying} retryError={retryError} onRetry={() => void retry()} />

        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-12">
          <Pane title="What you said" className="lg:order-1">
            <audio controls preload="metadata" src={`/api/files/${tt.audio.locationId}`} className="mb-5 h-11 w-full" aria-label="Play the recording" />
            <Transcript status={status} />
          </Pane>
          <Pane title="Drafted steps" className="max-lg:-order-1 lg:order-2">
            <Draft status={status} />
          </Pane>
        </div>
      </div>
    </>
  );
}

// Where the recording has got, as three plain steps; the current one says what's happening.
const STAGES = ["Sent", "Transcript", "Steps"] as const;

function stageOf(status: TalkThroughStatus): { done: number; note: string } {
  switch (status.kind) {
    case "transcribing":
      return { done: 1, note: "Transcribing the recording. A few minutes of talking usually takes under a minute." };
    case "drafting":
      return { done: 2, note: "Turning what you said into numbered steps." };
    case "ready":
      return { done: 3, note: "Check the steps against what you meant, then use them." };
    case "no_draft":
      return { done: 2, note: status.message };
    case "failed":
      return { done: status.stage === "transcribe" ? 1 : 2, note: status.message };
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function Progress({ status }: { status: TalkThroughStatus }) {
  const { done, note } = stageOf(status);
  const stuck = status.kind === "failed" || status.kind === "no_draft";
  return (
    <div className="mt-6" aria-live="polite">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label-small">
        {STAGES.map((stage, i) => {
          const reached = i < done;
          const current = i === done && !stuck;
          return (
            <li key={stage} className="flex items-center gap-2">
              {i > 0 ? <span aria-hidden className="h-px w-4 bg-border-raised sm:w-8" /> : null}
              <span
                aria-hidden
                className={cn(
                  "size-2 rounded-full",
                  reached ? "bg-content-primary" : current ? "bg-content-tertiary motion-safe:animate-pulse" : "bg-background-tertiary",
                )}
              />
              <span className={reached ? "text-content-primary" : "text-content-tertiary"}>
                {stage}
                {reached ? <span className="sr-only">, done</span> : current ? <span className="sr-only">, in progress</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-paragraph-small text-content-secondary">{note}</p>
    </div>
  );
}

function NextStep({ tt, retrying, retryError, onRetry }: { tt: TalkThrough; retrying: boolean; retryError: string | null; onRetry: () => void }) {
  if (tt.used !== null) {
    return (
      <p className="mt-6 rounded-control border border-border-opaque bg-background-secondary px-4 py-3 text-paragraph-small text-content-secondary">
        These steps are saved as version {tt.used.version}.{" "}
        <Link href={protocolHref(tt.used.protocolId)} className="text-content-accent underline underline-offset-2">
          Open it
        </Link>
      </p>
    );
  }
  const again = recordHref(tt.page === null ? { pageKind: tt.kind } : { protocolId: tt.page.protocolId });
  const edit = (source: "steps" | "transcript") => `${talkThroughHref(tt.id)}/edit${source === "transcript" ? "?from=transcript" : ""}`;
  const status = tt.status;
  const startFromTranscript =
    status.kind !== "transcribing" && status.transcript !== null && status.transcript.trim() !== "" ? (
      <Link href={edit("transcript")} className={buttonVariants({ variant: "secondary" })}>
        Start from the transcript
      </Link>
    ) : null;
  switch (status.kind) {
    case "transcribing":
    case "drafting":
      return null;
    case "ready":
      return (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link href={edit("steps")} className={buttonVariants()}>
            Use these steps
          </Link>
          <p className="text-paragraph-small text-content-tertiary">
            {tt.page === null
              ? "You can edit them before saving."
              : "You can edit them before saving."}
          </p>
        </div>
      );
    case "no_draft":
      return (
        // With words to start from, that's the way on; with none, recording again is.
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {startFromTranscript === null ? null : (
            <Link href={edit("transcript")} className={buttonVariants()}>
              Start from the transcript
            </Link>
          )}
          <Link href={again} className={buttonVariants({ variant: startFromTranscript === null ? "primary" : "secondary" })}>
            Record again
          </Link>
        </div>
      );
    case "failed":
      return (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={onRetry} disabled={retrying}>
            {retrying ? "Retrying" : "Retry"}
          </Button>
          {startFromTranscript}
          {retryError !== null ? (
            <p role="alert" className="text-paragraph-small text-content-primary">
              {retryError}
            </p>
          ) : null}
        </div>
      );
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function Pane({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("min-w-0", className)}>
      <h2 id={id} className="mb-4 text-heading-xsmall">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Lines({ count }: { count: number }) {
  const widths = ["w-full", "w-11/12", "w-4/5", "w-full", "w-3/4", "w-5/6", "w-2/3"];
  return (
    <div className="grid gap-3" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", widths[i % widths.length])} />
      ))}
    </div>
  );
}

function Transcript({ status }: { status: TalkThroughStatus }) {
  if (status.kind === "transcribing") return <Lines count={7} />;
  if (status.transcript === null) return <p className="text-paragraph-medium text-content-tertiary">No transcript yet.</p>;
  if (status.transcript.trim() === "") return <p className="text-paragraph-medium text-content-tertiary">No speech heard.</p>;
  return (
    <p className="max-h-[60dvh] overflow-auto rounded-control border border-border-opaque bg-background-raised p-4 text-paragraph-medium whitespace-pre-wrap text-content-secondary sm:p-5">
      {status.transcript}
    </p>
  );
}

function Draft({ status }: { status: TalkThroughStatus }) {
  switch (status.kind) {
    case "transcribing":
    case "drafting":
      return (
        <div className="rounded-control border border-border-opaque bg-background-raised p-4 sm:p-6">
          <Skeleton className="mb-5 h-5 w-1/3" />
          <Lines count={5} />
        </div>
      );
    case "ready":
      return (
        <div className="rounded-control border border-border-opaque bg-background-raised p-4 sm:p-6">
          <Markdown body={status.body} className="text-paragraph-medium" />
        </div>
      );
    case "no_draft":
    case "failed":
      return <p className="text-paragraph-medium text-content-tertiary">No steps.</p>;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
