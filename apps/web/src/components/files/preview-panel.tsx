"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { formatNumber } from "@/lib/checks";
import { cn } from "@/lib/cn";
import { cellText, columnLabel, mainTable, type DataTable } from "@/lib/data-tables";
import { isTextBearing, type FileHit, type FileLocation } from "@/lib/domain";
import { openTarget } from "@/lib/format";
import { fileNodeId, localMapHref } from "@/lib/map";
import { newProtocolHref } from "@/lib/protocols";
import { textOverflows } from "@/lib/row-summary";
import { tableSlice, type PreviewSize } from "@/lib/table-preview";
import { FileCharts, MakeChartLink } from "../charts/file-charts";
import { FileFlags } from "../flags/file-flags";
import { MapIcon, OpenExternalIcon, ProtocolIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { Highlighted } from "../search/highlighted";
import { buttonVariants } from "../ui/button";
import { When } from "@/components/ui/when";

// The opened state of a file row. A short preview, and beside it the one obvious action,
// opening the real file, over a short list of the rest. Under them the file's labels (when
// the row has them) and, only when there are any, its checks, other places and charts.
export function PreviewPanel({
  hit,
  query,
  id,
  className,
  labels,
  offerNewPage = true,
}: {
  hit: FileHit;
  query: string;
  id: string;
  className?: string;
  // The Labels section, from rows that edit labels (search, the calendar's day).
  labels?: ReactNode;
  offerNewPage?: boolean;
}) {
  const [primary, ...others] = hit.locations;
  const open = openTarget(primary);
  const isSheet = hit.fileKind === "spreadsheet";
  const newPage = offerNewPage && isTextBearing(hit.fileKind);
  return (
    <div id={id} className={cn("grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]", className)}>
      <Preview hit={hit} query={query} />
      <div className="flex min-w-0 flex-col items-start gap-3">
        {open === null ? null : (
          <a href={open.href} target="_blank" rel="noreferrer" className={buttonVariants({ size: "compact" })}>
            <OpenExternalIcon className="size-5" />
            {open.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        <div className="flex flex-col items-start">
          {isSheet ? <MakeChartLink hit={hit} /> : null}
          <Link href={localMapHref(fileNodeId(hit.sha256))} className={actionLink}>
            <MapIcon className="size-5" />
            Map around this file
          </Link>
          {newPage ? (
            <Link href={newProtocolHref(hit.sha256)} className={actionLink}>
              <ProtocolIcon className="size-5" />
              Make a protocol from this file
            </Link>
          ) : null}
        </div>
      </div>
      {labels}
      <div className="flex min-w-0 flex-col items-start gap-6 empty:hidden">
        {isSheet ? <FileFlags sha={hit.sha256} /> : null}
        {others.length === 0 ? null : <OtherPlaces locations={others} />}
        {isSheet ? <FileCharts hit={hit} /> : null}
      </div>
    </div>
  );
}

// The same shape as Make a chart's link, so the list reads as one.
const actionLink = cn(buttonVariants({ variant: "tertiary", size: "compact" }), "-ml-3 text-content-secondary");

function OtherPlaces({ locations }: { locations: readonly FileLocation[] }) {
  return (
    <div className="w-full min-w-0">
      <h3 className="text-label-medium text-content-primary">Also in</h3>
      <ul className="mt-2 grid gap-2">
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
    </div>
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
