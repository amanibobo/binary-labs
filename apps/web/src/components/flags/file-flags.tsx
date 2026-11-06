"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { formatNumber, rangeText } from "@/lib/checks";
import { cn } from "@/lib/cn";
import type { FileChecks, FileCheck, Flag } from "@/lib/flags";
import { fileName, flagHref, REVIEW_NAMES } from "@/lib/flags";
import type { Sha256 } from "@/lib/ids";
import { protocolHref } from "@/lib/protocols";
import { FlagIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";

// A read value: the number in mono, as values are across the app, and its unit beside it.
export function Value({ v, unit, className }: { v: number; unit: string | null; className?: string }) {
  return (
    <span className={className}>
      <span className="font-mono">{formatNumber(v)}</span>
      {unit === null ? null : ` ${unit}`}
    </span>
  );
}

export const fileChecksKey = (sha: Sha256) => ["file-checks", sha] as const;

// A data sheet's opened row: its open flags in amber first, then how every other check that
// reaches it came out. Polls while a check is on its way.
export function FileFlags({ sha }: { sha: Sha256 }) {
  const api = useLabApi();
  const query = useQuery({
    queryKey: fileChecksKey(sha),
    queryFn: ({ signal }) => api.fileChecks(sha, signal),
    refetchInterval: (q) => (q.state.data?.checking ? 3000 : false),
  });
  if (query.data === undefined) return null;
  return <FileFlagsList data={query.data} />;
}

export function FileFlagsList({ data }: { data: FileChecks }) {
  const others = data.checks.filter((c) => c.outcome.kind !== "flagged");
  if (data.flags.length === 0 && others.length === 0) {
    return data.checking ? <p className="text-paragraph-small text-content-tertiary">Checking against its protocol…</p> : null;
  }
  return (
    <div className="w-full min-w-0">
      <h3 className="text-label-medium text-content-primary">Checks</h3>
      {data.flags.length === 0 ? null : (
        <ul className="mt-2 grid gap-2">
          {data.flags.map((flag) => (
            <li key={flag.id}>
              <FlagLine flag={flag} />
            </li>
          ))}
        </ul>
      )}
      {others.length === 0 ? null : (
        <ul className="mt-2 grid gap-1.5">
          {others.map((check) => (
            <li key={`${check.protocolId} ${check.checkId}`}>
              <CheckLine check={check} />
            </li>
          ))}
        </ul>
      )}
      {data.checking ? <p className="mt-2 text-paragraph-xsmall text-content-tertiary">Checking again…</p> : null}
    </div>
  );
}

// One open flag, linking to its page: what was read, what was expected, and from where.
// On a file it says which protocol raised it; on a protocol, which file.
export function FlagLine({ flag, on = "file", className }: { flag: Flag; on?: "file" | "protocol"; className?: string }) {
  return (
    <Link
      href={flagHref(flag.id)}
      className={cn(
        "flex items-start gap-2.5 rounded-lg bg-background-warning px-3 py-2.5 text-content-warning transition-opacity duration-150 ease-out hover:opacity-90",
        className,
      )}
    >
      <FlagIcon className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">
        <span className="block text-label-small">{flag.checkName}</span>
        <span className="block text-paragraph-small">
          <Value v={flag.observed} unit={flag.unit} />, expected {rangeText(flag.expected, flag.unit)}
        </span>
        <span className="block text-paragraph-xsmall [overflow-wrap:anywhere]">
          {on === "file" ? `From ${flag.protocolTitle} v${flag.protocolVersion}` : fileName(flag.source)}
          {flag.answer === null ? "" : ` · Answered ${REVIEW_NAMES[flag.answer.review].toLowerCase()}`}
        </span>
      </span>
    </Link>
  );
}

function CheckLine({ check }: { check: FileCheck }) {
  const source = (
    <Link href={protocolHref(check.protocolId)} className="text-content-accent underline-offset-2 hover:underline">
      {check.protocolTitle} v{check.protocolVersion}
    </Link>
  );
  switch (check.outcome.kind) {
    case "passed":
      return (
        <p className="text-paragraph-small text-content-secondary">
          {check.checkName}: <Value v={check.outcome.observed} unit={check.unit} />, within{" "}
          {rangeText(check.expected, check.unit)} · {source}
        </p>
      );
    case "couldnt":
      return (
        <p className="text-paragraph-small text-content-secondary">
          {check.checkName}: couldn&apos;t check · {source}
          <span className="block text-paragraph-xsmall text-content-tertiary">{check.outcome.reason}</span>
        </p>
      );
    case "flagged":
      return null;
    default: {
      const _exhaustive: never = check.outcome;
      return _exhaustive;
    }
  }
}
