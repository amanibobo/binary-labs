"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { LABEL_FONT, TICK_FONT, TITLE_FONT } from "@/lib/chart-geometry";
import { numbersCsv } from "@/lib/chart-numbers";
import { rangeText, valueText } from "@/lib/checks";
import { flagHref } from "@/lib/flags";
import { protocolHref } from "@/lib/protocols";
import { describeHistory, HISTORY_COLUMNS, historyHref, historyRows, plotHistory, runDay, type HistoryPlot, type HistoryRun, type RunHistory } from "@/lib/run-history";
import { isFailed, runName } from "@/lib/runs";
import { sampleTitle } from "@/lib/sample";
import { useDemoLab } from "../demo-lab";
import { Breadcrumbs } from "../ui/breadcrumbs";
import { Button } from "../ui/button";
import { inputVariants } from "../ui/field";
import { ExportMenu, type ExportKind } from "./export-menu";
import { downloadPdf, downloadPng, downloadSvg, EXPORT_SIZES, figureMarkup, fileName, render, saveText, type ExportSize } from "./chart-export";
import { Frame, useWidth } from "./chart-figure";
import { EXPORT_INK, SCREEN_INK, type ChartInk } from "./chart-svg";

// A protocol check's run history (decisions.md, "charts round 2"): every run's value against the
// range it was held to, flagged runs amber, failed runs a gray ring, with the numbers and the
// same downloads as any chart.

const BAND_OPACITY = 0.12;

function Diamond({ x, y, r, fill, stroke }: { x: number; y: number; r: number; fill: string; stroke: string }) {
  return <path d={`M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`} fill={fill} stroke={stroke} strokeWidth={1.5} />;
}

// A run's mark: a dot in range, an amber diamond when flagged, a dashed gray ring when the run
// is labeled failed (amber ring if it was flagged too), so no state is color alone.
function RunMark({ x, y, flagged, failed, ink }: { x: number; y: number; flagged: boolean; failed: boolean; ink: ChartInk }) {
  if (failed) return <circle cx={x} cy={y} r={5.5} fill={ink.surface} stroke={flagged ? ink.flag : ink.series.muted} strokeWidth={2} strokeDasharray="3 2" />;
  if (flagged) return <Diamond x={x} y={y} r={6} fill={ink.flag} stroke={ink.surface} />;
  return <circle cx={x} cy={y} r={4} fill={ink.series.blue} stroke={ink.surface} strokeWidth={1.5} />;
}

export function HistorySvg({ plot, ink, label, children }: { plot: HistoryPlot; ink: ChartInk; label: string; children?: ReactNode }) {
  const { area } = plot;
  const bottom = area.top + area.height;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={plot.width}
      height={plot.height}
      viewBox={`0 0 ${plot.width} ${plot.height}`}
      role="img"
      aria-label={label}
      fontFamily={ink.font}
      style={{ display: "block", fontVariantNumeric: "tabular-nums" }}
    >
      {ink.background === null ? null : <rect width={plot.width} height={plot.height} fill={ink.background} />}
      {plot.title === null ? null : (
        <text x={plot.title.x} y={plot.title.y} fontSize={TITLE_FONT} fontWeight={600} fill={ink.title}>
          {plot.title.text}
        </text>
      )}
      <path d={plot.band} fill={ink.series.blue} fillOpacity={BAND_OPACITY} stroke="none" />
      <g>
        {plot.yTicks.map((t) => (
          <line key={`g${t.label}`} x1={area.left} x2={area.left + area.width} y1={t.pos} y2={t.pos} stroke={ink.grid} strokeWidth={1} shapeRendering="crispEdges" />
        ))}
        <line x1={area.left} x2={area.left + area.width} y1={bottom} y2={bottom} stroke={ink.axis} strokeWidth={1} shapeRendering="crispEdges" />
      </g>
      <g fontSize={TICK_FONT} fill={ink.tick}>
        {plot.yTicks.map((t) => (
          <text key={`y${t.label}`} x={area.left - 8} y={t.pos} textAnchor="end" dominantBaseline="middle">
            {t.label}
          </text>
        ))}
        {plot.xTicks.map((t, i) => (
          <text key={`x${i}`} x={t.pos} y={bottom + TICK_FONT + 6} textAnchor="middle">
            {t.label}
          </text>
        ))}
      </g>
      <g fontSize={LABEL_FONT} fill={ink.label}>
        <text x={plot.xTitle.x} y={plot.xTitle.y} textAnchor="middle">
          {plot.xTitle.text}
        </text>
        <text x={plot.yTitle.x} y={plot.yTitle.y} textAnchor="middle" transform={`rotate(-90 ${plot.yTitle.x} ${plot.yTitle.y})`}>
          {plot.yTitle.text}
        </text>
      </g>
      {plot.line === "" ? null : <path d={plot.line} stroke={ink.series.blue} strokeWidth={1.5} fill="none" strokeLinejoin="round" />}
      <g>
        {plot.points.map((p) => (
          <RunMark key={p.index} x={p.px} y={p.py} flagged={p.flagged} failed={p.failed} ink={ink} />
        ))}
      </g>
      <g fontSize={TICK_FONT} fill={ink.label}>
        {plot.legend.map((item) => (
          <g key={item.kind}>
            {item.kind === "band" ? (
              <rect x={item.x} y={item.y - 6} width={16} height={12} rx={2} fill={ink.series.blue} fillOpacity={BAND_OPACITY * 1.6} />
            ) : (
              <RunMark x={item.x + 8} y={item.y} flagged={item.kind === "flagged"} failed={item.kind === "failed"} ink={ink} />
            )}
            <text x={item.x + 22} y={item.y} dominantBaseline="middle">
              {item.text}
            </text>
          </g>
        ))}
      </g>
      {children}
    </svg>
  );
}

function historyHeight(width: number): number {
  return Math.round(Math.min(460, Math.max(280, width * 0.5)));
}

const resultWords = (r: HistoryRun) => (r.result === "flagged" ? "Flagged" : r.result === "passed" ? "In range" : "Couldn't check");

function Readout({ plot, run, index }: { plot: HistoryPlot; run: HistoryRun; index: number }) {
  const x = plot.stops[index] ?? 0;
  const onLeft = x > plot.area.left + plot.area.width / 2;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-40 rounded-control border border-border-opaque bg-background-raised px-3 py-2 shadow-deep-below"
      style={{ top: plot.area.top, ...(onLeft ? { right: plot.width - x + 14 } : { left: x + 14 }) }}
    >
      <p className="text-paragraph-xsmall text-content-tertiary">{[runDay(run.run), isFailed(run.run) ? (run.run.run === null ? "labeled failed" : "marked failed") : null].filter(Boolean).join(" · ")}</p>
      <p className="text-label-small text-content-primary">{runName(run.run)}</p>
      <p className="mt-0.5 text-paragraph-small text-content-primary tabular-nums">{run.observed === null ? "No value" : valueText(run.observed, run.unit)}</p>
      <p className="text-paragraph-xsmall text-content-secondary">
        {resultWords(run)}. Allowed {rangeText(run.range, run.unit)}, version {run.version}.
      </p>
    </div>
  );
}

export function RunHistoryView({ history }: { history: RunHistory }) {
  const router = useRouter();
  const [box, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [size, setSize] = useState<ExportSize>("column");
  const pickId = useId();
  const title = `${history.check.name} across runs`;
  const demo = useDemoLab();
  const height = width === null ? 320 : historyHeight(width);
  const plot = useMemo(() => (width === null ? null : plotHistory(history, { width, height: historyHeight(width) })), [history, width]);
  const sentence = describeHistory(history);
  const runs = history.runs;

  function point(event: PointerEvent<SVGRectElement>) {
    if (plot === null || runs.length === 0) return;
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (rect === undefined) return;
    const step = plot.area.width / runs.length;
    const i = Math.floor((event.clientX - rect.left - plot.area.left) / step);
    setActive(i >= 0 && i < runs.length ? i : null);
  }

  function step(event: KeyboardEvent<HTMLDivElement>) {
    const by = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (by === undefined && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    setActive((cur) => (event.key === "Home" ? 0 : event.key === "End" ? runs.length - 1 : Math.min(runs.length - 1, Math.max(0, (cur ?? 0) + (by ?? 0)))));
  }

  async function exportAs(kind: ExportKind) {
    const fileTitle = sampleTitle(title, demo);
    try {
      if (kind === "csv") {
        saveText(numbersCsv([{ title: history.check.name, columns: HISTORY_COLUMNS, rows: historyRows(history) }], [fileTitle, `From ${history.protocol.title}`]), fileName(fileTitle, "csv"), "text/csv");
        return;
      }
      const box = EXPORT_SIZES[size];
      const drawn = plotHistory(history, { width: box.width, height: box.height }, { title: fileTitle });
      const file = figureMarkup(
        { element: <HistorySvg plot={drawn} ink={EXPORT_INK} label={fileTitle} />, width: box.width, height: box.height, mm: box.mm === null ? null : { width: box.mm, height: Math.round(((box.mm * box.height) / box.width) * 10) / 10 } },
        render,
      );
      if (kind === "svg") downloadSvg(file, fileTitle);
      else if (kind === "pdf") await downloadPdf(file, fileTitle);
      else await downloadPng(file, fileTitle);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't make that file.");
    }
  }

  const run = active === null ? undefined : runs[active];
  return (
    <>
      <div className="border-b border-border-opaque">
        <div className="mx-auto flex min-h-14 w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-8">
          <div className="min-w-0 flex-1">
            <Breadcrumbs items={[{ label: "Protocols", href: "/protocols" }, { label: history.protocol.title, href: protocolHref(history.protocol.id) }, { label: "Run history", href: "#" }]} />
          </div>
          <ExportMenu disabled={runs.length === 0} size={size} onSize={setSize} onExport={(kind) => void exportAs(kind)} csvHelp="Each run's value, range, result and protocol version, unrounded" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-24 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="text-heading-small text-content-primary sm:text-heading-medium">{title}</h1>
          {history.checks.length < 2 ? null : (
            <div className="grid gap-1">
              <label htmlFor={pickId} className="text-label-small text-content-secondary">
                Check
              </label>
              <select id={pickId} value={history.check.id} onChange={(e) => router.push(historyHref(history.protocol.id, history.checks.find((c) => c.id === e.target.value)?.id ?? history.check.id))} className={inputVariants({ size: "compact" })}>
                {history.checks.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <p className="mt-2 max-w-3xl text-paragraph-medium text-content-secondary">{sentence}</p>
        <figure className="mt-6 min-w-0">
          <Frame box={box} height={height} label={`${title}. Use the arrow keys to read runs.`} onKeyDown={step} onFocus={() => setActive((cur) => cur ?? (runs.length > 0 ? 0 : null))} onBlur={() => setActive(null)}>
            {plot === null || runs.length === 0 ? null : (
              <HistorySvg plot={plot} ink={SCREEN_INK} label={title}>
                {active === null ? null : <line x1={plot.stops[active]} x2={plot.stops[active]} y1={plot.area.top} y2={plot.area.top + plot.area.height} stroke={SCREEN_INK.axis} strokeWidth={1} pointerEvents="none" />}
                <rect x={plot.area.left} y={plot.area.top} width={plot.area.width} height={plot.area.height} fill="transparent" onPointerMove={point} onPointerLeave={() => setActive(null)} />
              </HistorySvg>
            )}
            {plot === null || run === undefined || active === null ? null : <Readout plot={plot} run={run} index={active} />}
          </Frame>
          <figcaption className="mt-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1 basis-72 text-paragraph-xsmall text-content-tertiary">
              {(plot?.notes ?? []).map((n) => (
                <p key={n}>{n}</p>
              ))}
            </div>
            {runs.length === 0 ? null : (
              <Button variant="secondary" size="compact" className="shrink-0 text-content-secondary" aria-expanded={showTable} onClick={() => setShowTable((v) => !v)}>
                {showTable ? "Hide the numbers" : "Show the numbers"}
              </Button>
            )}
          </figcaption>
          {showTable ? <HistoryTable history={history} /> : null}
        </figure>
      </div>
    </>
  );
}

function HistoryTable({ history }: { history: RunHistory }) {
  return (
    <div className="mt-2 max-h-96 overflow-auto rounded-control border border-border-opaque">
      <table className="w-full text-left text-paragraph-xsmall tabular-nums">
        <thead className="sticky top-0 bg-background-secondary">
          <tr>
            {["Run", "Day", "Value", "Allowed", "Result"].map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-content-secondary">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {history.runs.map((r) => (
            <tr key={r.run.sha256} className="border-t border-border-opaque">
              <td className="px-3 py-1.5 text-content-primary">
                <Link href={`/?${new URLSearchParams({ q: r.run.name, open: r.run.sha256 })}`} className="underline-offset-2 hover:underline">
                  {runName(r.run)}
                </Link>
                {isFailed(r.run) ? <span className="text-content-tertiary"> · failed</span> : null}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-content-secondary">{runDay(r.run) ?? ""}</td>
              <td className="px-3 py-1.5 whitespace-nowrap text-content-primary">{r.observed === null ? "" : valueText(r.observed, r.unit)}</td>
              <td className="px-3 py-1.5 whitespace-nowrap text-content-secondary">{rangeText(r.range, r.unit)}</td>
              <td className="px-3 py-1.5 text-content-secondary">
                {r.flagId !== null ? (
                  <Link href={flagHref(r.flagId)} className="text-content-warning underline-offset-2 hover:underline">
                    Flagged
                  </Link>
                ) : r.result === "couldnt" ? (
                  `Couldn't check: ${r.reason ?? ""}`
                ) : (
                  resultWords(r)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
