import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { fixtureHistory } from "@/fixtures/run-history";
import { figureMarkup } from "@/components/charts/chart-export";
import { EXPORT_INK } from "@/components/charts/chart-svg";
import { HistorySvg } from "@/components/charts/history-chart";
import { numbersCsv } from "../chart-numbers";
import { describeHistory, HISTORY_COLUMNS, historyRows, plotHistory, rangeBounds, RunHistoryWire } from "../run-history";
import { parseSvg, svgToPdf } from "../pdf";

const size = { width: 800, height: 400 };

describe("a check's run history", () => {
  it("says what each point and the band are, and what stands out", () => {
    expect(describeHistory(fixtureHistory)).toBe(
      "Standard curve fit for each of the 10 runs of Bradford assay checked so far, oldest on the left. The shaded band is the allowed range (at least 0.98 now; it changed over time). 1 run fell outside it and is amber. 1 run is labeled failed and drawn as a gray ring, not left out.",
    );
    expect(describeHistory({ ...fixtureHistory, runs: [] })).toMatch(/hasn't been checked on any run yet/);
  });

  it("puts a point per checked run, amber when flagged and a ring when failed, in order", () => {
    const plot = plotHistory(fixtureHistory, size);
    expect(plot.points.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 8, 9]);
    expect(plot.points.filter((p) => p.flagged).map((p) => p.index)).toEqual([3]);
    expect(plot.points.filter((p) => p.failed).map((p) => p.index)).toEqual([6]);
    const xs = plot.points.map((p) => p.px);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    // The flagged run sits lowest, below the band.
    expect(Math.max(...plot.points.map((p) => p.py))).toBe(plot.points.find((p) => p.flagged)?.py);
    expect(plot.legend.map((l) => l.text)).toEqual(["Allowed range", "In range", "Flagged", "Failed run"]);
  });

  it("joins the runs that weren't failed and leaves the failed one as a ring off the line", () => {
    const plot = plotHistory(fixtureHistory, size);
    const failed = plot.points.find((p) => p.failed);
    expect(plot.line.split(/[ML]/).filter(Boolean)).toHaveLength(8);
    expect(plot.line).not.toContain(`${failed?.px} ${failed?.py}`);
  });

  it("shades the band each run was checked against, one stretch per range", () => {
    const plot = plotHistory(fixtureHistory, size);
    expect(plot.band.match(/M/g)).toHaveLength(2);
    expect(rangeBounds({ kind: "around", target: 280, tolerance: 2 })).toEqual({ lo: 278, hi: 282 });
    expect(rangeBounds({ kind: "at_most", max: 0.1 })).toEqual({ lo: null, hi: 0.1 });
  });

  it("names the run it couldn't check and why, and the version change", () => {
    const plot = plotHistory(fixtureHistory, size);
    expect(plot.notes).toEqual([
      "1 run couldn't be checked, so it has no point: Bradford_2026-10-26 (Fewer than three standards had a reading).",
      "Runs were checked under versions 2 and 3; each run's band is the range of the version it was checked against.",
    ]);
  });

  it("exports as a PDF and SVG with its title, and as CSV, unrounded", () => {
    const plot = plotHistory(fixtureHistory, { width: 413, height: 330 }, { title: "Standard curve R² across runs" });
    const file = figureMarkup({ element: createElement(HistorySvg, { plot, ink: EXPORT_INK, label: "x" }), width: 413, height: 330, mm: { width: 85, height: 67.9 } }, renderToStaticMarkup);
    expect(file.markup).toContain('width="85mm"');
    expect(file.markup).toContain("Standard curve R² across runs");
    expect(file.markup).toContain('fill="#b26f00"');
    expect(parseSvg(file.markup)).not.toBeNull();
    expect(svgToPdf(file.markup, { width: 241, height: 192 }).length).toBeGreaterThan(1000);
    const csv = numbersCsv([{ title: "Standard curve R²", columns: HISTORY_COLUMNS, rows: historyRows(fixtureHistory) }], ["t"]).split("\r\n");
    expect(csv[3]).toBe("Run,Date,Outcome,Value,Unit,Allowed range,Result,Why not checked,Protocol version");
    expect(csv[7]).toBe("Bradford_2026-10-18,2026-10-18,worked,0.884,,at least 0.95,flagged,,2");
    expect(csv[11]).toBe("Bradford_2026-10-26,2026-10-26,worked,,,at least 0.98,couldn't check,Fewer than three standards had a reading.,3");
  });

  it("goes over the wire as it was", () => {
    expect(RunHistoryWire.parse(JSON.parse(JSON.stringify(fixtureHistory)))).toEqual(fixtureHistory);
  });
});
