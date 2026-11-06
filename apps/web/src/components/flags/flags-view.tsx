"use client";

import Link from "next/link";
import { useId } from "react";
import { rangeText } from "@/lib/checks";
import { cn } from "@/lib/cn";
import { fileName, flagHref, queueOrder, REVIEW_NAMES, type Flag } from "@/lib/flags";
import { FlagIcon } from "../icons/drawn";
import { Value } from "./file-flags";
import { dataRow, dataSurface } from "../ui/data-table";
import { When } from "../ui/when";

// The Flags queue: open flags nobody has answered, newest first, then the ones people answered.
export function FlagsView({ flags }: { flags: readonly Flag[] }) {
  const { waiting, answered } = queueOrder(flags);
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-8 pb-24 sm:px-8 sm:pt-16">
      <h1 className="text-heading-large">Flags</h1>
      <p className="mt-1 max-w-prose text-paragraph-medium text-content-tertiary">
        Results outside their protocol&apos;s expected values. Say whether each one was useful.
      </p>
      {waiting.length === 0 && answered.length === 0 ? (
        <p className="mt-8 text-paragraph-medium text-content-secondary">No flags right now. Results that miss a protocol&apos;s checks show up here.</p>
      ) : null}
      {waiting.length === 0 ? (
        answered.length === 0 ? null : <p className="mt-8 text-paragraph-medium text-content-secondary">Every flag has an answer.</p>
      ) : (
        <FlagList flags={waiting} className="mt-8" />
      )}
      {answered.length === 0 ? null : <AnsweredList flags={answered} />}
    </div>
  );
}

function AnsweredList({ flags }: { flags: Flag[] }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-12">
      <h2 id={headingId} className="text-heading-xsmall">
        Answered
      </h2>
      <FlagList flags={flags} className="mt-4" />
    </section>
  );
}

function FlagList({ flags, className }: { flags: Flag[]; className?: string }) {
  return (
    <ul className={cn(dataSurface, className)}>
      {flags.map((flag) => (
        <li key={flag.id} className={dataRow}>
          <FlagRow flag={flag} />
        </li>
      ))}
    </ul>
  );
}

function FlagRow({ flag }: { flag: Flag }) {
  const answered = flag.answer !== null;
  return (
    <Link
      href={flagHref(flag.id)}
      className="flex items-start gap-4 px-4 py-4 transition-colors duration-150 ease-out hover:bg-background-secondary focus-visible:outline-offset-[-2px] sm:px-5"
    >
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
          answered ? "bg-background-tertiary text-content-tertiary" : "bg-background-warning text-content-warning",
        )}
      >
        <FlagIcon className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-label-medium text-content-primary">{flag.checkName}</span>
          <span className={cn("truncate text-paragraph-xsmall text-content-tertiary", (flag.source.file?.cleanName ?? null) === null && "font-mono")}>{fileName(flag.source)}</span>
        </span>
        <span className="mt-1 block text-paragraph-small text-content-secondary">
          <Value v={flag.observed} unit={flag.unit} className={cn(!answered && "text-content-warning")} />, expected{" "}
          {rangeText(flag.expected, flag.unit)}
        </span>
        <span className="mt-0.5 block text-paragraph-xsmall text-content-tertiary">
          From {flag.protocolTitle} v{flag.protocolVersion} · <When iso={flag.raisedAt} />
          {flag.answer === null ? "" : ` · ${REVIEW_NAMES[flag.answer.review]}`}
        </span>
      </span>
    </Link>
  );
}
