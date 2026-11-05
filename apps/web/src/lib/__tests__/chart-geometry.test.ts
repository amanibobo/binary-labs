import { describe, expect, it } from "vitest";
import bradfordJson from "@/fixtures/tables/Bradford_2026-10-30.json";
import secJson from "@/fixtures/tables/SEC_trace_141026.json";
import { ChartSpec } from "../charts";
import { barPath, linearTicks, logTicks, niceDomain, plotChart } from "../chart-geometry";
import { DataTables } from "../data-tables";

const sec = DataTables.parse(secJson).tables[0];
const [standards, samples] = DataTables.parse(bradfordJson).tables;
const size = { width: 800, height: 460 };

const spec = (over: object) =>
  ChartSpec.parse({
    version: 1,
    type: "line",
    x: { column: "A", title: "Volume", unit: "ml", min: null, max: null },
    y: { title: "A280", unit: "mAU", scale: "linear", min: null, max: null },
    series: [{ column: "B", name: "A280", color: "blue", error: null }],
    legend: "top",
    ...over,
  });

describe("ticks", () => {
  it("land on 1, 2 and 5 steps", () => {
    expect(linearTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(linearTicks(0, 640, 6)).toEqual([0, 100, 200, 300, 400, 500, 600]);
    expect(niceDomain(0.43, 1.23, 5)).toEqual([0.4, 1.4]);
    expect(logTicks(1, 1000)).toEqual([1, 10, 100, 1000]);
    expect(logTicks(1, 50)).toEqual([1, 2, 5, 10, 20, 50]);
  });
});

describe("a line chart of the AKTA trace", () => {
  const plot = plotChart(spec({}), sec, size);

  it("draws one unbroken line over every row, with the axis titles carrying units", () => {
    const [line] = plot.series;
    expect(line.points).toHaveLength(961);
    expect(line.path?.match(/M/g)).toHaveLength(1);
    expect(line.markers).toBe(false);
    expect(plot.xTitle?.text).toBe("Volume (ml)");
    expect(plot.yTitle?.text).toBe("A280 (mAU)");
    expect(plot.legend).toEqual([]);
    expect(plot.stops).toHaveLength(961);
  });

  it("keeps the peak when a narrow chart thins the line", () => {
    const narrow = plotChart(spec({}), sec, { width: 300, height: 260 });
    const path = narrow.series[0].path ?? "";
    const ys = [...path.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeLessThan(961);
    const narrowTop = Math.min(...narrow.series[0].points.map((p) => p.py));
    expect(Math.min(...ys)).toBeCloseTo(narrowTop, 0);
  });

  it("breaks a line where a value is blank, and names two series in a legend", () => {
    const two = plotChart(
      spec({
        series: [
          { column: "B", name: "A280", color: "blue", error: null },
          { column: "F", name: "Conductivity", color: "orange", error: null },
        ],
      }),
      sec,
      size,
    );
    expect(two.legend.map((l) => l.name)).toEqual(["A280", "Conductivity"]);
    expect(two.series[1].points).toHaveLength(241);
  });

  it("leaves non-positive values off a log scale and says so", () => {
    const log = plotChart(spec({ y: { title: "", unit: "", scale: "log", min: null, max: null } }), sec, size);
    expect(log.notes[0]).toMatch(/values at or below zero left off the log scale/);
    expect(log.yTicks.every((t) => /^[\d.,K]+$/.test(t.label))).toBe(true);
  });
});

describe("the Bradford curve", () => {
  it("draws error bars around each mean", () => {
    const plot = plotChart(
      spec({ type: "scatter", x: { column: "A", title: "BSA", unit: "µg/mL", min: null, max: null }, series: [{ column: "E", name: "Mean", color: "blue", error: "F" }] }),
      standards,
      size,
    );
    const [s] = plot.series;
    expect(s.points).toHaveLength(8);
    expect(s.whiskers).toHaveLength(8);
    for (const [i, w] of s.whiskers.entries()) {
      expect(w.top).toBeLessThan(s.points[i].py);
      expect(w.bottom).toBeGreaterThan(s.points[i].py);
    }
    expect(s.markers).toBe(true);
  });

  it("draws samples as bars from zero, at most 24px wide", () => {
    const bars = plotChart(
      spec({ type: "bar", x: { column: "A", title: "", unit: "", min: null, max: null }, series: [{ column: "D", name: "Protein", color: "blue", error: null }] }),
      samples,
      size,
    );
    expect(bars.series[0].bars).toHaveLength(7);
    expect(bars.series[0].bars.every((b) => b.width <= 24)).toBe(true);
    expect(bars.xTicks.map((t) => t.label)).toContain("Elution 1");
    expect(bars.baseline).not.toBeNull();
  });
});

it("rounds a bar at its data end and leaves it square at the baseline", () => {
  expect(barPath(10, 20, 100, 40)).toBe("M10 100V44Q10 40 14 40H26Q30 40 30 44V100Z");
});
