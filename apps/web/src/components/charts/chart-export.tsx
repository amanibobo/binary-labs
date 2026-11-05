"use client";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ChartSpec } from "@/lib/charts";
import { plotChart } from "@/lib/chart-geometry";
import type { DataTable } from "@/lib/data-tables";
import { ChartSvg, EXPORT_INK } from "./chart-svg";

// A figure for a slide or a paper: 960 by 560 with the title on it, in the light colors on
// white. The PNG is drawn at twice that.
export const EXPORT_SIZE = { width: 960, height: 560 };

export function chartMarkup(spec: ChartSpec, table: DataTable, title: string): string {
  const plot = plotChart(spec, table, EXPORT_SIZE, { title });
  const host = document.createElement("div");
  const root = createRoot(host);
  flushSync(() => root.render(<ChartSvg plot={plot} ink={EXPORT_INK} clipId="plot" label={title} />));
  const markup = host.innerHTML;
  root.unmount();
  return `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`;
}

export function fileName(title: string, extension: "svg" | "png"): string {
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

export function downloadSvg(markup: string, title: string): void {
  save(new Blob([markup], { type: "image/svg+xml" }), fileName(title, "svg"));
}

export async function downloadPng(markup: string, title: string, scale = 2): Promise<void> {
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = EXPORT_SIZE.width * scale;
    canvas.height = EXPORT_SIZE.height * scale;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This browser can't draw a PNG here.");
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, EXPORT_SIZE.width, EXPORT_SIZE.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob === null) throw new Error("This browser can't draw a PNG here.");
    save(blob, fileName(title, "png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}
