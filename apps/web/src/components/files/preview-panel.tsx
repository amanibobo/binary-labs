"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { useState, type ReactNode } from "react";
import { chartHref, newChartHref } from "@/lib/charts";
import { formatNumber } from "@/lib/checks";
import { cn } from "@/lib/cn";
import { cellText, columnLabel, mainTable, type DataTable } from "@/lib/data-tables";
import { isTextBearing, type FileHit, type FileLocation, type NoteInfo, type NotePage } from "@/lib/domain";
import { openTarget } from "@/lib/format";
import { fileNodeId, localMapHref } from "@/lib/map";
import { openingPage } from "@/lib/notes";
import { newProtocolHref } from "@/lib/protocols";
import { textOverflows } from "@/lib/row-summary";
import { tableSlice, type PreviewSize } from "@/lib/table-preview";
import { fileChartsKey } from "../charts/file-charts";
import { fileChecksKey, FileFlagsList } from "../flags/file-flags";
import { ChartIcon, ChevronSmallIcon, FlagIcon, MapIcon, OpenExternalIcon, ProtocolIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { Highlighted } from "../search/highlighted";
import { buttonVariants } from "../ui/button";
import { menuItem, menuSurface } from "../ui/menu";
import { When } from "@/components/ui/when";
import { NoteControls, NotePreview } from "./note-pages";

// The opened state of a file row, read first and edited on demand. A short preview (a note's
// pages step through it), and beside it the actions on one line: Open, Make a chart for a data
// sheet, and the rest under More. Under them the labels as a few quiet lines, then one line
// each for charts, checks and other places, which open in place.
export function PreviewPanel({
  hit,
  query,
  id,
  className,
  labels,
  note = null,
  offerNewPage = true,
}: {
  hit: FileHit;
  query: string;
  id: string;
  className?: string;
  // The Labels section, from rows that edit labels (search, the calendar's day).
  labels?: ReactNode;
  // The note this file is the first page of, when the row shows a note.
  note?: NoteInfo | null;
  offerNewPage?: boolean;
}) {
  const [primary, ...others] = hit.locations;
  const [page, setPage] = useState<NotePage | null>(() => (note === null ? null : openingPage(note, hit.matchedPage)));
  // A note can lose the page on screen (taken out, or the note split).
  const shown = note === null ? null : (note.pages.find((p) => p.sha256 === page?.sha256) ?? note.pages[0]);
  const isSheet = hit.fileKind === "spreadsheet";
  const opens = shown?.location ?? primary;
  return (
    <div id={id} className={cn("grid gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]", className)}>
      {note !== null && shown !== null ? (
        <NotePreview hit={hit} note={note} page={shown} onPage={setPage} />
      ) : (
        <Preview hit={hit} query={query} />
      )}
      <div className="flex min-w-0 flex-col items-start gap-3 max-lg:-order-1">
        <Actions hit={hit} opens={opens} offerNewPage={offerNewPage} />
        {note !== null ? <NoteControls hit={hit} note={note} /> : null}
        {isSheet || others.length > 0 ? (
          <div className="grid w-full min-w-0 gap-0.5 empty:hidden">
            {isSheet ? <FlagsLine hit={hit} /> : null}
            {isSheet ? <ChartsLine hit={hit} /> : null}
            {others.length === 0 ? null : <OtherPlaces locations={others} />}
          </div>
        ) : null}
      </div>
      {labels === undefined ? null : <div className="min-w-0 lg:col-span-2">{labels}</div>}
    </div>
  );
}

// Open, the one primary action; Make a chart beside it for a data sheet, where testers found
// it too quiet in a list; the map and a protocol from the file behind More.
function Actions({ hit, opens, offerNewPage }: { hit: FileHit; opens: FileLocation; offerNewPage: boolean }) {
  const open = openTarget(opens);
  const newPage = offerNewPage && isTextBearing(hit.fileKind);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {open === null ? null : (
        <a href={open.href} target="_blank" rel="noreferrer" className={buttonVariants({ size: "compact" })}>
          <OpenExternalIcon className="size-5" />
          {open.label}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
      {hit.fileKind === "spreadsheet" ? (
        <Link href={newChartHref(hit.locations[0].id)} className={buttonVariants({ variant: "secondary", size: "compact" })}>
          <ChartIcon className="size-5" />
          Make a chart
        </Link>
      ) : null}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className={cn(buttonVariants({ variant: "tertiary", size: "compact" }), "gap-1 pr-2 text-content-secondary")}>
          More
          <ChevronSmallIcon className="size-4 rotate-90" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={6} className={menuSurface}>
            <DropdownMenu.Item asChild className={menuItem}>
              <Link href={localMapHref(fileNodeId(hit.sha256))}>
                <MapIcon className="size-5 text-content-secondary" />
                Map around this file
              </Link>
            </DropdownMenu.Item>
            {newPage ? (
              <DropdownMenu.Item asChild className={menuItem}>
                <Link href={newProtocolHref(hit.sha256)}>
                  <ProtocolIcon className="size-5 text-content-secondary" />
                  Make a protocol from this file
                </Link>
              </DropdownMenu.Item>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

// One line that opens in place to what it counts.
function Disclosure({ summary, tone = "quiet", children }: { summary: ReactNode; tone?: "quiet" | "flag"; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "-mx-1.5 inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-left text-paragraph-small transition-colors duration-150 ease-out hover:bg-background-tertiary max-sm:min-h-11",
          tone === "flag" ? "text-content-warning" : "text-content-secondary",
        )}
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronSmallIcon className={cn("size-4 shrink-0 transition-transform duration-150 ease-out", open ? "-rotate-90" : "rotate-90")} />
      </button>
      {open ? <div className="mt-1.5 mb-1">{children}</div> : null}
    </div>
  );
}

// "3 charts: Plate 7 kinetics at 420 nm and 2 more", opening to the list.
function ChartsLine({ hit }: { hit: FileHit }) {
  const api = useLabApi();
  const query = useQuery({ queryKey: fileChartsKey(hit.sha256), queryFn: ({ signal }) => api.fileCharts(hit.sha256, signal) });
  const charts = query.data ?? [];
  const [first] = charts;
  if (first === undefined) return null;
  const more = charts.length - 1;
  return (
    <Disclosure
      summary={
        <>
          <ChartIcon className="mr-1.5 inline size-4 align-[-3px] text-content-tertiary" />
          {charts.length === 1 ? "1 chart" : `${charts.length} charts`}: {first.title}
          {more > 0 ? ` and ${more} more` : ""}
        </>
      }
    >
      <ul className="grid gap-1.5">
        {charts.map((c) => (
          <li key={c.id} className="min-w-0 text-paragraph-small">
            <Link href={chartHref(c.id)} className="text-content-accent underline-offset-2 hover:underline">
              {c.title}
            </Link>
            <span className="text-paragraph-xsmall text-content-tertiary">
              {" "}
              · Saved <When iso={c.updatedAt} />
            </span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

// "1 flag: Standard curve fit" in amber when a check flagged the sheet, else how many checks
// passed; either opens to the checks.
function FlagsLine({ hit }: { hit: FileHit }) {
  const api = useLabApi();
  const query = useQuery({
    queryKey: fileChecksKey(hit.sha256),
    queryFn: ({ signal }) => api.fileChecks(hit.sha256, signal),
    refetchInterval: (q) => (q.state.data?.checking ? 3000 : false),
  });
  const data = query.data;
  if (data === undefined || (data.flags.length === 0 && data.checks.length === 0)) return null;
  const [flag] = data.flags;
  const summary =
    flag !== undefined ? (
      <>
        <FlagIcon className="mr-1.5 inline size-4 align-[-3px]" />
        {data.flags.length === 1 ? "1 flag" : `${data.flags.length} flags`}: {flag.checkName}
        {data.flags.length > 1 ? ` and ${data.flags.length - 1} more` : ""}
      </>
    ) : (
      `${data.checks.length === 1 ? "1 check" : `${data.checks.length} checks`}, nothing flagged`
    );
  return (
    <Disclosure summary={summary} tone={flag === undefined ? "quiet" : "flag"}>
      <FileFlagsList data={data} />
    </Disclosure>
  );
}

function OtherPlaces({ locations }: { locations: readonly FileLocation[] }) {
  return (
    <Disclosure summary={locations.length === 1 ? "Also in 1 other place" : `Also in ${locations.length} other places`}>
      <ul className="grid gap-2">
        {locations.map((location) => {
          const target = openTarget(location);
          return (
            <li key={location.id} className="min-w-0 text-paragraph-small">
              {target === null ? (
                <span className="font-mono [overflow-wrap:anywhere] text-content-secondary">{location.path}</span>
              ) : (
                <a
                  href={target.href}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono [overflow-wrap:anywhere] text-content-accent underline-offset-2 hover:underline"
                >
                  {location.path}
                  <span className="sr-only"> ({target.label}, opens in a new tab)</span>
                </a>
              )}
              <span className="block text-paragraph-xsmall text-content-tertiary">
                Modified <When iso={location.modifiedAt} />
              </span>
            </li>
          );
        })}
      </ul>
    </Disclosure>
  );
}

const frame = "rounded-xl border border-border-opaque bg-background-primary";

function Preview({ hit, query }: { hit: FileHit; query: string }) {
  const api = useLabApi();
  if (hit.hasPreview) {
    return (
      <div className={cn(frame, "flex min-h-32 items-center justify-center overflow-hidden")}>
        {/* eslint-disable-next-line @next/next/no-img-element -- previews are short-lived presigned redirects */}
        <img
          src={api.previewUrl(hit.sha256, { view: true })}
          alt={`Preview of ${hit.locations[0].originalName}`}
          className="max-h-72 w-full object-contain"
        />
      </div>
    );
  }
  if (hit.fileKind === "spreadsheet") return <SheetPreview hit={hit} query={query} />;
  return <TextPreview hit={hit} query={query} />;
}

// A data sheet shows its table, not the instrument's header text: the first rows and columns
// as read for charts, with the header lines behind "Notes from the instrument". Until the
// table is read (or when it can't be), the text preview stands in.
function SheetPreview({ hit, query }: { hit: FileHit; query: string }) {
  const api = useLabApi();
  const state = useQuery({
    queryKey: ["table-preview", hit.sha256],
    queryFn: ({ signal }) => api.dataTable(hit.sha256, signal),
    staleTime: 60_000,
  });
  const table = state.data?.state === "ready" ? mainTable(state.data.tables) : null;
  if (state.isPending) return <div className={cn(frame, "h-44")} aria-hidden />;
  if (table === null || table.columns.length === 0) return <TextPreview hit={hit} query={query} />;
  const sheets = state.data?.state === "ready" ? state.data.tables.tables.length : 1;
  return <TablePreview table={table} sheets={sheets} query={query} />;
}

function TablePreview({ table, sheets, query }: { table: DataTable; sheets: number; query: string }) {
  const [size, setSize] = useState<PreviewSize>("short");
  const [notesOpen, setNotesOpen] = useState(false);
  const slice = tableSlice({ table, size });
  const shortCut = tableSlice({ table, size: "short" }).cut;
  return (
    <div className="min-w-0">
      <div className={cn(frame, "overflow-auto", size === "long" && "max-h-96")}>
        <table className="w-full text-paragraph-xsmall tabular-nums">
          <thead className="sticky top-0 bg-background-primary">
            <tr className="border-b border-border-opaque">
              {slice.columns.map((column) => (
                <th key={column.id} scope="col" className="px-2.5 py-2 text-left font-medium whitespace-nowrap text-content-secondary">
                  {columnLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: slice.rows }, (_, row) => (
              <tr key={row}>
                {slice.columns.map((column) => (
                  <td key={column.id} className={cn("px-2.5 py-1 whitespace-nowrap text-content-primary", column.kind === "number" && "font-mono")}>
                    <Highlighted text={cellText(column, row, formatNumber)} query={query} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-paragraph-xsmall text-content-tertiary">
        <span>
          {sheets > 1 ? `${table.name} · ` : ""}
          {slice.size}
        </span>
        {shortCut ? (
          <button type="button" onClick={() => setSize(size === "short" ? "long" : "short")} className={smallToggle}>
            {size === "short" ? "Show more" : "Show less"}
          </button>
        ) : null}
        {table.notes.length > 0 ? (
          <button type="button" aria-expanded={notesOpen} onClick={() => setNotesOpen((o) => !o)} className={smallToggle}>
            Notes from the instrument
          </button>
        ) : null}
      </div>
      {notesOpen ? (
        <ul className="mt-2 grid gap-0.5 font-mono text-paragraph-xsmall [overflow-wrap:anywhere] text-content-secondary">
          {table.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const smallToggle =
  "-mx-1 rounded-md px-1 text-content-secondary underline-offset-2 hover:text-content-primary hover:underline max-sm:min-h-11";

function TextPreview({ hit, query }: { hit: FileHit; query: string }) {
  const [more, setMore] = useState(false);
  if (hit.snippet === null) {
    return <div className={cn(frame, "flex min-h-20 items-center p-4 text-paragraph-small text-content-tertiary")}>No preview for this file yet.</div>;
  }
  const long = textOverflows(hit.snippet);
  return (
    <div className="min-w-0">
      <div
        className={cn(
          frame,
          "overflow-auto p-4 text-paragraph-small whitespace-pre-wrap [overflow-wrap:anywhere] text-content-primary",
          more ? "max-h-96" : "max-h-44 overflow-hidden",
        )}
      >
        <Highlighted text={hit.snippet} query={query} />
      </div>
      {long ? (
        <button type="button" onClick={() => setMore((m) => !m)} className={cn(smallToggle, "mt-1.5 text-paragraph-xsmall")}>
          {more ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
