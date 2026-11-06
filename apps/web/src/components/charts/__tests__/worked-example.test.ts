import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import doseJson from "@/fixtures/tables/viability_drugA.json";
import { analyzeDose } from "@/lib/analysis";
import { rename, withRepeats } from "@/lib/chart-edits";
import { describeChart, startChart, suggestionsFor } from "@/lib/chart-guide";
import { chartNumbers, numbersCsv } from "@/lib/chart-numbers";
import { CreateChartRequest, isSummary, type ChartSpec } from "@/lib/charts";
import { DataTables, mainTable } from "@/lib/data-tables";
import { assignWells, emptyLayout, fillSeries, wellsBetween } from "@/lib/layouts";
import { parseSvg, svgToPdf } from "@/lib/pdf";
import type { ChartData } from "@/lib/summary-guide";
import { exportFigure, figureMarkup, pdfPage } from "../chart-export";

// The plan's worked example, end to end on the fixture plate exported without its layout: mark
// the wells, take the suggested dose-response, read its IC50 and range, switch SEM to SD, add µM,
// export an SVG at a single journal column, and keep the wells with the saved chart. Set
// EXAMPLE_OUT to a directory to keep the files it makes.

const doc = DataTables.parse(doseJson);
const table = mainTable(doc);
if (table === null) throw new Error("no plate");

// What a student marks: blanks down column 1, the vehicle down column 2, Drug A from 100 µM
// down by fives across columns 3 to 7, rows B to D.
let layout = assignWells(emptyLayout(96), wellsBetween({ row: 1, column: 0 }, { row: 3, column: 0 }), { role: "blank", name: "", conc: null, dilution: null });
layout = assignWells(layout, wellsBetween({ row: 1, column: 1 }, { row: 3, column: 1 }), { role: "control", name: "", conc: 0, dilution: null });
layout = fillSeries(layout, wellsBetween({ row: 1, column: 2 }, { row: 3, column: 6 }), { role: "sample", name: "Drug A", start: 100, factor: 5, direction: "across" });
const data: ChartData = { table, tables: doc.tables, layout: { layout, layoutId: null, from: "" } };

function dose(spec: ChartSpec | null) {
  if (spec === null || spec.type !== "dose") throw new Error(`not a dose-response chart: ${spec?.type ?? "nothing"}`);
  return spec;
}

describe("the worked example", () => {
  it("opens on the plate, and once the wells are marked suggests a dose-response first", () => {
    expect(suggestionsFor({ ...data, layout: null })[0]?.kind).toBe("heatmap");
    expect(suggestionsFor(data).map((s) => s.kind)).toEqual(["dose", "bar", "heatmap"]);
  });

  const started = dose(startChart(data, "dose"));
  const result = analyzeDose(table, started).series[0];

  it("finds the IC50 with its 95% range, the plate's true 2.4 µM inside it", () => {
    expect(result?.term).toBe("IC50");
    if (result?.verdict.kind !== "ok") throw new Error("no IC50");
    expect(result.verdict.ci[0]).toBeLessThan(2.4);
    expect(result.verdict.ci[1]).toBeGreaterThan(2.4);
    expect(started.blank).toBe(true);
  });

  it("switches SD to SEM and back without touching the fit", () => {
    const sem = analyzeDose(table, dose(withRepeats(started, { spread: "sem" })));
    const sd = analyzeDose(table, dose(withRepeats(started, { spread: "sd" })));
    const [g] = sd.series[0]?.doses ?? [];
    const [h] = sem.series[0]?.doses ?? [];
    expect(h?.half).toBeCloseTo((g?.half ?? 0) / Math.sqrt(3), 12);
    expect(sem.series[0]?.params).toEqual(sd.series[0]?.params);
  });

  const named = dose(rename(withRepeats(started, { spread: "sd" }), table, { kind: "x" }, "Drug A (µM)"));

  it("takes µM typed on the axis into the sentence", () => {
    expect(named.x).toMatchObject({ title: "Drug A", unit: "µM", scale: "log" });
    expect(describeChart(named, table, doc.tables)).toMatch(/^A570 for 5 doses of Drug A from 0\.16 to 100 µM, 3 wells each, fitted with a four-parameter curve; IC50 \d\.\d+ µM \(\d\.\d+ to \d\.\d+\)\./);
  });

  const figure = figureMarkup(exportFigure(named, table, "Drug A viability, plate 2", "column", doc.tables), renderToStaticMarkup);

  it("exports an SVG 85 mm wide with the fit and its numbers written under it", () => {
    expect(figure.mm?.width).toBe(85);
    expect(figure.markup).toMatch(/<svg[^>]* width="85mm" height="[\d.]+mm" viewBox="0 0 413 /);
    expect(figure.markup).toContain("IC50 ");
    const svg = parseSvg(figure.markup);
    const text = JSON.stringify(svg);
    expect(text).toContain("Four-parameter logistic fit to every well on log dose");
    expect(text).toContain("Error bars show SD, n = 3 per dose.");
  });

  it("makes a PDF a reader can open: one page, 85 mm wide, every object where the index says", () => {
    const bytes = svgToPdf(figure.markup, pdfPage(figure));
    const pdf = Buffer.from(bytes).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    const width = Number(/\/MediaBox \[0 0 ([\d.]+)/.exec(pdf)?.[1]);
    expect(width).toBeCloseTo((85 / 25.4) * 72, 2);
    const xref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(pdf).toContain("(IC50 ");
    const out = process.env.EXAMPLE_OUT;
    if (out !== undefined) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "worked-example-85mm.svg"), figure.markup);
      writeFileSync(join(out, "worked-example-85mm.pdf"), bytes);
      const slides = figureMarkup(exportFigure(named, table, "Drug A viability, plate 2", "slides", doc.tables), renderToStaticMarkup);
      writeFileSync(join(out, "worked-example-slides.pdf"), svgToPdf(slides.markup, pdfPage(slides)));
    }
  });

  it("saves with its wells, and its numbers name each well", () => {
    const request = CreateChartRequest.parse({ sha256: "d2".repeat(32), sheet: table.name, title: "Drug A viability, plate 2", spec: named, protocolId: null });
    if (!isSummary(request.spec) || request.spec.source.kind !== "plate") throw new Error("not a plate chart");
    expect(request.spec.source.layout.groups.flatMap((g) => g.wells)).toHaveLength(21);
    const csv = numbersCsv(chartNumbers(named, analyzeDose(table, named)), ["Drug A viability, plate 2"]);
    expect(csv).toContain("B3: ");
    expect(csv).toMatch(/Drug A,IC50,\d\.\d+,\d\.\d+,\d\.\d+/);
  });
});
