"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { rangeText, valueText } from "@/lib/checks";
import type { ChartSpec } from "@/lib/charts";
import { newChartHref } from "@/lib/charts";
import { cn } from "@/lib/cn";
import type { DataTable } from "@/lib/data-tables";
import { fileName, REVIEW_NAMES, REVIEW_NOTE_MAX, REVIEWS, rowsText, type Cells, type Flag, type FlagAnswer, type Review } from "@/lib/flags";
import { openTarget } from "@/lib/format";
import { authorName, protocolHref, type AuthorNames } from "@/lib/protocols";
import { ChartFigure } from "../charts/chart-figure";
import { FlagIcon, OpenExternalIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { Breadcrumbs } from "../ui/breadcrumbs";
import { Button, buttonVariants } from "../ui/button";
import { Label, Textarea } from "../ui/field";
import { When } from "../ui/when";
import { useFlagCount } from "./flag-count";
import { FlagTable } from "./flag-table";
import { checksHref } from "./protocol-checks";

const KIND_READ = {
  curve_fit: "R² of the fit",
  peak: "Peak at",
  value: "Value",
  control: "Control",
} as const;

// One flag: what was read and what was expected, the protocol version that held the rule, the
// cells it came from with the rows used marked, and the answer people gave it.
export function FlagView({ flag, authors, initialReview }: { flag: Flag; authors: AuthorNames; initialReview?: Review }) {
  return (
    <>
      <div className="border-b border-border-opaque">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center px-4 sm:px-8">
          <Breadcrumbs items={[{ label: "Flags", href: "/flags" }, { label: flag.checkName, href: `/flags/${flag.id}` }]} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-4xl px-4 pt-8 pb-24 sm:px-8 sm:pt-12">
        <h1 className="text-heading-medium sm:text-heading-large">{flag.checkName}</h1>
        <p className="mt-2 text-paragraph-small text-content-tertiary [overflow-wrap:anywhere]">
          {fileName(flag.source)} · Raised <When iso={flag.raisedAt} />
        </p>

        {flag.state.kind === "cleared" ? (
          <p className="mt-6 rounded-control border border-border-opaque bg-background-secondary px-4 py-3 text-paragraph-small text-content-secondary">
            Cleared <When iso={flag.state.at} />. {flag.state.reason}
          </p>
        ) : null}

        <dl className="mt-8 grid gap-px overflow-hidden rounded-card border border-border-opaque bg-border-opaque sm:grid-cols-3">
          <Fact term={KIND_READ[flag.kind]} warn>
            <span className="inline-flex items-center gap-2">
              <FlagIcon className="size-5 shrink-0" />
              <span className="font-mono">{valueText(flag.observed, flag.unit)}</span>
            </span>
          </Fact>
          <Fact term="Expected">
            <span className="font-mono">{rangeText(flag.expected, flag.unit)}</span>
          </Fact>
          <Fact term="From">
            <Link href={protocolHref(flag.protocolId, flag.protocolVersion)} className="text-content-accent underline-offset-2 hover:underline">
              {flag.protocolTitle} v{flag.protocolVersion}
            </Link>
          </Fact>
        </dl>

        <ReviewSection flag={flag} authors={authors} initialReview={initialReview} />

        <Source title="Where it was read" cells={flag.source} kind={flag.kind} />
        {flag.control === null ? null : (
          <Source
            title={flag.control.sha256 === flag.source.sha256 ? "The controls" : "The day's controls, from another file"}
            cells={flag.control}
            kind="control"
          />
        )}
      </div>
    </>
  );
}

function Fact({ term, warn = false, children }: { term: string; warn?: boolean; children: ReactNode }) {
  return (
    <div className={cn("px-4 py-4 sm:px-5", warn ? "bg-background-warning text-content-warning" : "bg-background-raised")}>
      <dt className={cn("text-label-small", warn ? "" : "text-content-tertiary")}>{term}</dt>
      <dd className="mt-1 text-heading-xsmall [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function sourceLine(cells: Cells): string {
  const columns = cells.columns.length === 1 ? `column ${cells.columns[0]}` : `columns ${cells.columns.join(", ")}`;
  return `${cells.sheet}, ${columns}, ${rowsText(cells.rows)}`;
}

function Source({ title, cells, kind }: { title: string; cells: Cells; kind: Flag["kind"] }) {
  const api = useLabApi();
  const headingId = useId();
  const table = useQuery({
    queryKey: ["table", cells.sha256],
    queryFn: ({ signal }) => api.dataTable(cells.sha256, signal),
    enabled: cells.file !== null,
  });
  const found = table.data?.state === "ready" ? table.data.tables.tables.find((t) => t.name === cells.sheet) : undefined;
  const location = cells.file?.location ?? null;
  const open = location === null ? null : openTarget(location);
  return (
    <section aria-labelledby={headingId} className="mt-12">
      <h2 id={headingId} className="text-heading-xsmall">
        {title}
      </h2>
      <p className="mt-1 text-paragraph-small text-content-secondary [overflow-wrap:anywhere]">
        <span className="font-mono">{location?.originalName ?? "A file no longer in the lab"}</span> · {sourceLine(cells)}
      </p>
      {location === null ? null : (
        <div className="mt-3 flex flex-wrap gap-2">
          {open === null ? null : (
            <a href={open.href} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "compact" })}>
              <OpenExternalIcon className="size-5" />
              {open.label}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
          <Link href={newChartHref(location.id)} className={buttonVariants({ variant: "tertiary", size: "compact" })}>
            Make a chart
          </Link>
        </div>
      )}
      {found === undefined ? (
        table.isPending && cells.file !== null ? <p className="mt-4 text-paragraph-small text-content-tertiary">Loading the table…</p> : null
      ) : (
        <div className="mt-5 grid gap-6">
          {kind === "curve_fit" || kind === "peak" ? <SourceChart cells={cells} table={found} kind={kind} /> : null}
          <FlagTable table={found} columns={cells.columns} rows={cells.rows} caption={`${sourceLine(cells)}, the rows read marked`} />
        </div>
      )}
    </section>
  );
}

// The standards or the trace the check read, drawn the way a lab would look at them.
function SourceChart({ cells, table, kind }: { cells: Cells; table: DataTable; kind: "curve_fit" | "peak" }) {
  const [x, y] = cells.columns;
  const xc = table.columns.find((c) => c.id === x);
  const yc = table.columns.find((c) => c.id === y);
  if (xc === undefined || yc === undefined || xc.kind !== "number" || yc.kind !== "number") return null;
  const spec: ChartSpec = {
    version: 1,
    type: kind === "curve_fit" ? "scatter" : "line",
    x: { column: xc.id, title: xc.name, unit: xc.unit ?? "", min: null, max: null },
    y: { title: yc.name, unit: yc.unit ?? "", scale: "linear", min: null, max: null },
    series: [{ column: yc.id, name: yc.name, color: "blue", error: null }],
    legend: "top",
  };
  return <ChartFigure spec={spec} table={table} label={`${yc.name} against ${xc.name}`} />;
}

function ReviewSection({ flag, authors, initialReview }: { flag: Flag; authors: AuthorNames; initialReview?: Review }) {
  const api = useLabApi();
  const count = useFlagCount();
  const [answer, setAnswer] = useState<FlagAnswer | null>(flag.answer);
  const [choice, setChoice] = useState<Review | null>(initialReview ?? flag.answer?.review ?? null);
  const [note, setNote] = useState(flag.answer?.note ?? "");
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const noteId = useId();
  const changed = choice !== null && (choice !== answer?.review || (note.trim() || null) !== (answer?.note ?? null));

  async function save() {
    if (choice === null) return;
    setBusy(true);
    try {
      const saved = await api.reviewFlag(flag.id, { review: choice, note });
      if (answer === null && flag.state.kind === "open") count.shift(-1);
      setAnswer(saved);
      toast("Answer saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't save that answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="text-heading-xsmall">
        Was this flag useful?
      </h2>
      <p className="mt-1 text-paragraph-small text-content-tertiary">Answers tune the checks: a check that is often wrong gets looked at.</p>
      <div role="group" aria-labelledby={headingId} className="mt-4 flex flex-wrap gap-2">
        {REVIEWS.map((r) => (
          <Button
            key={r}
            variant={choice === r ? "primary" : "secondary"}
            aria-pressed={choice === r}
            onClick={() => setChoice(r)}
          >
            {REVIEW_NAMES[r]}
          </Button>
        ))}
      </div>
      {choice === "wrong" ? (
        <p className="mt-4 max-w-prose text-paragraph-small text-content-secondary">
          If the range is what&apos;s off, change it on the protocol; that saves a new version and checks its files again.{" "}
          <Link href={checksHref(flag.protocolId, { checkId: flag.checkId })} className="text-content-accent underline underline-offset-2">
            Edit this check&apos;s range
          </Link>
        </p>
      ) : null}
      <div className="mt-5 max-w-xl">
        <Label htmlFor={noteId}>Note</Label>
        <Textarea
          id={noteId}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={REVIEW_NOTE_MAX}
          rows={2}
          placeholder={choice === "known_issue" ? "What's known about it" : "Optional"}
          className="mt-1.5"
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button disabled={!changed || busy} onClick={() => void save()}>
          {busy ? "Saving" : answer === null ? "Save answer" : "Change answer"}
        </Button>
        {answer === null ? null : (
          <p className="text-paragraph-small text-content-tertiary">
            {REVIEW_NAMES[answer.review]}, said by {authorName(authors, answer.by)} <When iso={answer.at} />
            {answer.note === null ? "" : `: “${answer.note}”`}
          </p>
        )}
      </div>
    </section>
  );
}
