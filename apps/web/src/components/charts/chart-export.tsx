"use client";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { analyze } from "@/lib/analysis";
import { isHeatmap, isXY, type ChartSpec } from "@/lib/charts";
import { plotChart } from "@/lib/chart-geometry";
import { chartNumbers, numbersCsv } from "@/lib/chart-numbers";
import { cellText, columnLabel, findColumn, type DataColumn, type DataTable } from "@/lib/data-tables";
import { formatValue } from "@/lib/numbers";
import { plotPlate } from "@/lib/plate-geometry";
import { plotSummary } from "@/lib/summary-geometry";
import { ChartSvg, EXPORT_INK, PlateSvg } from "./chart-svg";
import { SummarySvg } from "./summary-svg";

// A figure for a paper or slides, in the light colors on white (decisions.md, "charts round 1").
// Print sizes are laid out so the 12-unit tick labels print at 7 pt, the size journals ask for:
// a single column is 85 mm wide (413 units), a double column 180 mm (874 units). Slides stay at
// 960 by 560. A PNG for print is 300 dpi; for slides, twice the size.

export const EXPORT_SIZES = {
  column: { label: "Single journal column (85 mm)", short: "85 mm", mm: 85, width: 413, height: 330 },
  double: { label: "Double column (180 mm)", short: "180 mm", mm: 180, width: 874, height: 480 },
  slides: { label: "Slides", short: "Slides", mm: null, width: 960, height: 560 },
} as const;
export type ExportSize = keyof typeof EXPORT_SIZES;
export const EXPORT_SIZE_KEYS = ["column", "double", "slides"] as const satisfies readonly ExportSize[];
export const EXPORT_SIZE = { width: EXPORT_SIZES.slides.width, height: EXPORT_SIZES.slides.height };

export type ChartFile = { markup: string; width: number; height: number; mm: { width: number; height: number } | null };

const MM_PER_INCH = 25.4;

function render(element: ReactElement): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  flushSync(() => root.render(element));
  const markup = host.innerHTML;
  root.unmount();
  return markup;
}

// The figure at an export size, before it's turned into markup.
export function exportFigure(spec: ChartSpec, table: DataTable, title: string, size: ExportSize = "slides", tables: readonly DataTable[] = [table]): { element: ReactElement; width: number; height: number; mm: ChartFile["mm"] } {
  const box = EXPORT_SIZES[size];
  const frame = { width: box.width, height: box.height };
  const sized = (element: ReactElement, width: number, height: number) => ({
    element,
    width,
    height,
    mm: box.mm === null ? null : { width: box.mm, height: Math.round(((box.mm * height) / width) * 10) / 10 },
  });
  if (isHeatmap(spec)) {
    const plot = plotPlate(spec, table, frame, { title });
    return sized(<PlateSvg plot={plot} ink={EXPORT_INK} gradientId="scale" label={title} />, plot.width, plot.height);
  }
  if (isXY(spec)) {
    const plot = plotChart(spec, table, frame, { title });
    return sized(<ChartSvg plot={plot} ink={EXPORT_INK} clipId="plot" label={title} />, plot.width, plot.height);
  }
  // The test, the fit and what the bars show go on the figure itself, under the chart.
  const plot = plotSummary(spec, table, frame, { title, caption: true }, tables);
  return sized(<SummarySvg plot={plot} ink={EXPORT_INK} clipId="plot" label={title} />, plot.width, plot.height);
}

// The figure's markup. Print sizes say their width in millimetres, so a journal's template and
// Illustrator place it at size.
export function figureMarkup(figure: ReturnType<typeof exportFigure>, toMarkup: (element: ReactElement) => string): ChartFile {
  const { mm } = figure;
  let markup = toMarkup(figure.element);
  if (mm !== null) markup = markup.replace(/^<svg([^>]*?) width="[^"]*" height="[^"]*"/, `<svg$1 width="${mm.width}mm" height="${mm.height}mm"`);
  return { markup: `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`, width: figure.width, height: figure.height, mm };
}

export function chartMarkup(spec: ChartSpec, table: DataTable, title: string, size: ExportSize = "slides", tables: readonly DataTable[] = [table]): ChartFile {
  return figureMarkup(exportFigure(spec, table, title, size, tables), render);
}

// A PDF page's size in points for the figure.
export function pdfPage(file: ChartFile): { width: number; height: number } {
  const points = (mm: number) => (mm / MM_PER_INCH) * 72;
  return file.mm === null ? { width: file.width * 0.75, height: file.height * 0.75 } : { width: points(file.mm.width), height: points(file.mm.height) };
}

export function fileName(title: string, extension: "svg" | "png" | "pdf" | "csv"): string {
  const safe = title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Chart";
  return `${safe.slice(0, 120)}.${extension}`;
}

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function saveText(text: string, name: string, type: string): void {
  save(new Blob([text], { type: `${type};charset=utf-8` }), name);
}

export function downloadSvg(file: ChartFile, title: string): void {
  save(new Blob([file.markup], { type: "image/svg+xml" }), fileName(title, "svg"));
}

// How many pixels a PNG gets per layout unit: 300 dpi at print sizes, twice for slides.
export function pngScale(file: ChartFile): number {
  return file.mm === null ? 2 : (file.mm.width / MM_PER_INCH) * (300 / file.width);
}

export async function downloadPng(file: ChartFile, title: string): Promise<void> {
  const scale = pngScale(file);
  const url = URL.createObjectURL(new Blob([file.markup.replace(/ width="[\d.]+mm" height="[\d.]+mm"/, ` width="${file.width}" height="${file.height}"`)], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(file.width * scale);
    canvas.height = Math.round(file.height * scale);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This browser can't draw a PNG here.");
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, file.width, file.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob === null) throw new Error("This browser can't draw a PNG here.");
    save(blob, fileName(title, "png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// A vector PDF. The writer loads only now, so the builder doesn't carry it.
export async function downloadPdf(file: ChartFile, title: string): Promise<void> {
  const { svgToPdf } = await import("@/lib/pdf");
  const bytes = svgToPdf(file.markup, pdfPage(file));
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  save(new Blob([copy.buffer], { type: "application/pdf" }), fileName(title, "pdf"));
}

// The numbers behind the chart: for a chart of repeats every group's n, mean and spreads, the
// test, the fit and the samples; for any other, the rows it draws.
export function chartCsv(spec: ChartSpec, table: DataTable, title: string, provenance: readonly string[], tables: readonly DataTable[] = [table]): string {
  const heading = [title, ...provenance];
  if (isHeatmap(spec)) return numbersCsv([{ title: table.name, columns: ["Well", "Value"], rows: plotPlate(spec, table, EXPORT_SIZE).wells.map((w) => [w.name, w.value]) }], heading);
  if (isXY(spec)) {
    const ids = [spec.x.column, ...spec.series.flatMap((s) => [s.x, s.column, s.error])];
    const columns = [...new Set(ids)].flatMap((id) => {
      const c = id === null ? undefined : findColumn(table, id);
      return c === undefined ? [] : [c];
    });
    const rows = Array.from({ length: table.rows }, (_, r) => r).filter((r) => columns.some((c: DataColumn) => c.values[r] !== null));
    return numbersCsv([{ title: table.name, columns: columns.map(columnLabel), rows: rows.map((r) => columns.map((c) => (c.kind === "number" ? (c.values[r] ?? null) : cellText(c, r, formatValue)))) }], heading);
  }
  return numbersCsv(chartNumbers(spec, analyze(table, spec, tables)), heading);
}
