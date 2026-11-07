"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { KIND_NAMES, protocolHref, type AuthorNames, authorName } from "@/lib/protocols";
import { acceptRequest, formatClock, isSettled, recordHref, talkThroughHref, type TalkThrough, type TalkThroughStatus } from "@/lib/talk-throughs";
import { useLabApi } from "../lab-api";
import { FollowUpQuestion } from "../labels/follow-up";
import { LabelsProvider, LabListsProvider, useLabels } from "../labels/labels-context";
import type { LabLists } from "@/lib/label-edit";
import type { Sha256 } from "@/lib/ids";
import { CrumbBar } from "../protocols/crumb-bar";
import { Markdown } from "../protocols/markdown";
import { Button, buttonVariants } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { When } from "@/components/ui/when";

const POLL_MS = 2_000;

// A talk-through: what was said (a recording made for it, or a video already on the page),
// its transcript, and the steps drafted from it, read against the page as it is now.
export function TalkThroughView({ initial, authors, lists }: { initial: TalkThrough; authors: AuthorNames; lists: LabLists }) {
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
  const video = tt.media.kind === "video";
  const heading = status.kind === "ready" ? status.title : video ? "Steps from a video" : "Talk-through";
  const pageLabel = tt.page === null ? `a new ${KIND_NAMES[tt.kind].toLowerCase()}` : tt.page.title;
  const showCurrent = tt.page !== null && tt.current !== null && tt.used === null && !tt.dismissed && status.kind === "ready";

  return (
    <>
      <CrumbBar
        items={[
          tt.page === null ? { label: "New protocol", href: "/protocols/new" } : { label: tt.page.title, href: protocolHref(tt.page.protocolId) },
          { label: video ? "Steps from a video" : "Talk-through", href: talkThroughHref(tt.id) },
        ]}
        width="max-w-6xl sm:px-6"
      />
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-24 sm:px-6 sm:pt-12">
        <h1 className="text-heading-medium sm:text-heading-large">{heading}</h1>
        <p className="mt-2 text-paragraph-small text-content-tertiary">
          {video ? (
            <>
              For {pageLabel}, from {tt.media.name} · Started <When iso={tt.recordedAt} /> by {authorName(authors, tt.recordedBy)}
            </>
          ) : (
            <>
              For {pageLabel} · Recorded <When iso={tt.recordedAt} /> by {authorName(authors, tt.recordedBy)}
              {tt.durationMs === null ? "" : ` · ${formatClock(tt.durationMs)}`}
            </>
          )}
        </p>

        {tt.dismissed ? null : <Progress status={status} video={video} />}

        <NextStep tt={tt} retrying={retrying} retryError={retryError} onRetry={() => void retry()} />

        {tt.recording === null || video ? null : (
          <LabListsProvider value={lists}>
            <LabelsProvider>
              <RecordingQuestion sha={tt.recording} />
            </LabelsProvider>
          </LabListsProvider>
        )}

        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-12">
          <Pane title={video ? "What was said" : "What you said"} className="lg:order-1">
            {video ? (
              // preload=metadata fetches only the start; the rest comes in ranges as it plays.
              <video controls playsInline preload="metadata" src={api.mediaUrl(tt.media.locationId)} className="mb-5 aspect-video w-full rounded-card bg-[#0b0d0e]" aria-label={`Play ${tt.media.name}`} />
            ) : (
              <audio controls preload="metadata" src={api.mediaUrl(tt.media.locationId)} className="mb-5 h-11 w-full" aria-label="Play the recording" />
            )}
            <Transcript status={status} />
          </Pane>
          <Pane title="Drafted steps" className="max-lg:-order-1 lg:order-2">
            <Draft status={status} />
          </Pane>
        </div>
        {showCurrent && tt.current !== null ? (
          <section aria-labelledby="current-heading" className="mt-12">
            <h2 id="current-heading" className="text-heading-xsmall">
              On the page now, version {tt.current.version}
            </h2>
            <p className="mt-1 text-paragraph-small text-content-tertiary">Saving the drafted steps replaces this.</p>
            <div className="mt-4 rounded-control border border-border-opaque p-4 text-content-secondary sm:p-6">
              <Markdown body={tt.current.body} className="text-paragraph-medium" />
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}

// The one question a voice note left open ("that thing from Tuesday"), with the lab's own
// choices to tap. Answering corrects the recording's label, and the question goes away.
function RecordingQuestion({ sha }: { sha: Sha256 }) {
  const api = useLabApi();
  const labels = useLabels();
  const query = useQuery({ queryKey: ["file-labels", [sha]], queryFn: ({ signal }) => api.fileLabels([sha], signal) });
  const found = query.data?.find((l) => l.sha256 === sha);
  if (found === undefined) return null;
  const file = { sha256: sha, label: found.label };
  const followUp = labels.labelOf(file)?.followUp ?? null;
  if (followUp === null) return null;
  return (
    <section aria-labelledby="question-heading" className="mt-6 max-w-xl rounded-control border border-border-opaque px-4 py-3">
      <h2 id="question-heading" className="text-label-medium text-content-primary">
        One question about this recording
      </h2>
      <FollowUpQuestion hit={file} followUp={followUp} className="mt-1" />
    </section>
  );
}

// Where it has got, as three plain steps; the current one says what's happening.
function stagesOf(video: boolean): readonly string[] {
  return video ? ["Video", "Transcript", "Steps"] : ["Sent", "Transcript", "Steps"];
}

function stageOf(status: TalkThroughStatus, video: boolean): { done: number; note: string } {
  switch (status.kind) {
    case "transcribing":
      return {
        done: 1,
        note: video
          ? "Waiting for the video's transcript. The steps are drafted as soon as it's in."
          : "Transcribing the recording. A few minutes of talking usually takes under a minute.",
      };
    case "drafting":
      return { done: 2, note: video ? "Turning what was said in the video into numbered steps." : "Turning what you said into numbered steps." };
    case "ready":
      return { done: 3, note: "Check the steps against what was meant, then save them, edit them first, or dismiss them." };
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

function Progress({ status, video }: { status: TalkThroughStatus; video: boolean }) {
  const { done, note } = stageOf(status, video);
  const stuck = status.kind === "failed" || status.kind === "no_draft";
  return (
    <div className="mt-6" aria-live="polite">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-label-small">
        {stagesOf(video).map((stage, i) => {
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
  const api = useLabApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"accept" | "dismiss" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

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
  if (tt.dismissed) {
    return (
      <p className="mt-6 rounded-control border border-border-opaque bg-background-secondary px-4 py-3 text-paragraph-small text-content-secondary">
        You dismissed these steps; the page is as it was.{" "}
        {tt.page === null ? null : (
          <Link href={protocolHref(tt.page.protocolId)} className="text-content-accent underline underline-offset-2">
            Back to {tt.page.title}
          </Link>
        )}
      </p>
    );
  }

  async function accept() {
    const req = acceptRequest(tt);
    if (req === null) return;
    setBusy("accept");
    setProblem(null);
    try {
      const outcome = await api.applyTalkThrough(tt.id, req);
      if (outcome.kind === "stale") {
        setProblem("Someone saved the page since these steps were drafted. Edit them first to fold in what changed.");
        return;
      }
      toast.success(`Saved as version ${outcome.version}`);
      router.push(protocolHref(outcome.protocolId));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "We couldn't save these steps. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function dismiss() {
    setBusy("dismiss");
    setProblem(null);
    try {
      await api.dismissTalkThrough(tt.id);
      await queryClient.invalidateQueries({ queryKey: ["talk-through", tt.id] });
      toast("Dismissed. The page is as it was.");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "We couldn't dismiss that. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const again = recordHref(tt.page === null ? { pageKind: tt.kind } : { protocolId: tt.page.protocolId });
  const edit = (source: "steps" | "transcript") => `${talkThroughHref(tt.id)}/edit${source === "transcript" ? "?from=transcript" : ""}`;
  const status = tt.status;
  const video = tt.media.kind === "video";
  const hasTranscript = status.kind !== "transcribing" && status.transcript !== null && status.transcript.trim() !== "";
  const dismissButton =
    tt.page === null ? null : (
      <Button variant="tertiary" onClick={() => void dismiss()} disabled={busy !== null}>
        {busy === "dismiss" ? "Dismissing" : "Dismiss"}
      </Button>
    );
  const alert =
    problem === null && retryError === null ? null : (
      <p role="alert" className="w-full text-paragraph-small text-content-primary">
        {problem ?? retryError}
      </p>
    );
  switch (status.kind) {
    case "transcribing":
    case "drafting":
      return null;
    case "ready":
      if (tt.page === null) {
        return (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link href={edit("steps")} className={buttonVariants()}>
              Use these steps
            </Link>
            <p className="text-paragraph-small text-content-tertiary">You can edit them before saving.</p>
          </div>
        );
      }
      return (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={() => void accept()} disabled={busy !== null}>
            {busy === "accept" ? "Saving" : `Save as version ${(tt.current?.version ?? tt.page.baseVersion) + 1}`}
          </Button>
          <Link href={edit("steps")} className={buttonVariants({ variant: "secondary" })}>
            Edit first
          </Link>
          {dismissButton}
          {alert}
        </div>
      );
    case "no_draft":
      // With words to start from, that's the way on; with none, recording again is.
      return (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {hasTranscript ? (
            <Link href={edit("transcript")} className={buttonVariants()}>
              Start from the transcript
            </Link>
          ) : null}
          {video ? null : (
            <Link href={again} className={buttonVariants({ variant: hasTranscript ? "secondary" : "primary" })}>
              Record again
            </Link>
          )}
          {dismissButton}
          {alert}
        </div>
      );
    case "failed":
      return (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={onRetry} disabled={retrying}>
            {retrying ? "Retrying" : "Retry"}
          </Button>
          {hasTranscript ? (
            <Link href={edit("transcript")} className={buttonVariants({ variant: "secondary" })}>
              Start from the transcript
            </Link>
          ) : null}
          {dismissButton}
          {alert}
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
