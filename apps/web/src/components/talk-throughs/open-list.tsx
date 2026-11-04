import Link from "next/link";
import { useId } from "react";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import { authorName, KIND_NAMES, type AuthorNames } from "@/lib/protocols";
import { formatClock, talkThroughHref, type OpenTalkThrough } from "@/lib/talk-throughs";
import { FileAudioIcon } from "../icons/drawn";
import { dataRow, dataSurface } from "../ui/data-table";

const PROGRESS = {
  transcribing: "Transcribing",
  drafting: "Drafting steps",
  ready: "Steps ready to check",
  needs_you: "Didn't finish",
} satisfies Record<OpenTalkThrough["progress"], string>;

// Recordings waiting for someone to check their steps. Nothing shows when there are none.
export function OpenTalkThroughs({
  items,
  authors,
  heading,
  className,
}: {
  items: readonly OpenTalkThrough[];
  authors: AuthorNames;
  heading: string;
  className?: string;
}) {
  const id = useId();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id} className={className}>
      <h2 id={id} className="mb-3 text-heading-xsmall">
        {heading}
      </h2>
      <ul className={dataSurface}>
        {items.map((t) => (
          <li key={t.id} className={dataRow}>
            <Link href={talkThroughHref(t.id)} className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-button-secondary-hover">
              <FileAudioIcon className="size-5 shrink-0 text-tint-yellow" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-label-medium text-content-primary">{t.title ?? `${KIND_NAMES[t.kind]} talk-through`}</span>
                <span className="block truncate text-paragraph-small text-content-tertiary">
                  {formatDate(t.recordedAt)} by {authorName(authors, t.recordedBy)}
                  {t.durationMs === null ? "" : ` · ${formatClock(t.durationMs)}`}
                </span>
              </span>
              <span className={cn("shrink-0 text-paragraph-small", t.progress === "ready" ? "text-content-primary" : "text-content-tertiary")}>
                {PROGRESS[t.progress]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
