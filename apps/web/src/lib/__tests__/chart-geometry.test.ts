import { describe, expect, it } from "vitest";
import bioreactorJson from "@/fixtures/tables/Bioreactor_run12.json";
import bradfordJson from "@/fixtures/tables/Bradford_2026-10-30.json";
import plateJson from "@/fixtures/tables/plate7_A420.json";
import secJson from "@/fixtures/tables/SEC_trace_141026.json";
import { ChartSpec, nextStyle, type Series, type XYSpec } from "../charts";
import { barPath, linearTicks, logTicks, niceDomain, plotChart, pointAt, timeTicks } from "../chart-geometry";
import { DataTables } from "../data-tables";

const sec = DataTables.parse(secJson).tables[0];
const [standards, samples] = DataTables.parse(bradfordJson).tables;
const bioreactor = DataTables.parse(bioreactorJson).tables[0];
const kinetic = DataTables.parse(plateJson).tables[0];
const size = { width: 800, height: 460 };

const spec = (over: object): XYSpec => {
  const s = ChartSpec.parse({
    version: 1,
    type: "line",
    x: { column: "A", title: "Volume", unit: "ml", min: null, max: null },
    y: { title: "A280", unit: "mAU", scale: "linear", min: null, max: null },
    series: [{ column: "B", name: "A280", color: "blue", error: null }],
    legend: "top",
    ...over,
  });
  if (s.type === "heatmap") throw new Error("not x/y");
  return s;
};

describe("ticks", () => {
  it("land on 1, 2 and 5 steps", () => {
    expect(linearTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(linearTicks(0, 640, 6)).toEqual([0, 100, 200, 300, 400, 500, 600]);
    expect(niceDomain(0.43, 1.23, 5)).toEqual([0.4, 1.4]);
    expect(logTicks(1, 1000)).toEqual([1, 10, 100, 1000]);
    expect(logTicks(1, 50)).toEqual([1, 2, 5, 10, 20, 50]);
  });

  it("on a time axis, from minutes to months, label the unit that changes", () => {
    const at = (iso: string) => Date.parse(`${iso}Z`);
    const minutes = timeTicks(at("2026-11-03T17:44:00"), at("2026-11-03T18:14:00"), 6);
    expect(minutes.values.map(minutes.label)).toEqual(["17:45", "17:50", "17:55", "18:00", "18:05", "18:10"]);
    const days = timeTicks(at("2026-11-10T09:00:00"), at("2026-11-13T09:00:00"), 8);
    expect(days.values.map(days.label)).toEqual(["12:00", "Nov 11", "12:00", "Nov 12", "12:00", "Nov 13"]);
    const months = timeTicks(at("2026-10-15T00:00:00"), at("2027-03-01T00:00:00"), 5);
    expect(months.values.map(months.label)).toEqual(["Nov", "Dec", "2027", "Feb", "Mar"]);
    const seconds = timeTicks(at("2026-11-03T17:44:00"), at("2026-11-03T17:44:40"), 4);
    expect(seconds.values.map(seconds.label)).toEqual(["17:44:00", "17:44:10", "17:44:20", "17:44:30", "17:44:40"]);
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

  it("leaves non-positive values off a log scale and says so", () => {
    const log = plotChart(spec({ y: { title: "", unit: "", scale: "log", min: null, max: null } }), sec, size);
    expect(log.notes[0]).toMatch(/values at or below zero left off the log scale/);
    expect(log.yTicks.every((t) => /^[\d.,K]+$/.test(t.label))).toBe(true);
  });
});

describe("AKTA curves each on their own volume column", () => {
  const two = (cond: object) =>
    spec({
      series: [
        { column: "B", name: "A280", color: "blue", error: null },
        { column: "F", name: "Conductivity", color: "orange", error: null, ...cond },
      ],
    });
  const shared = plotChart(two({}), sec, size);
  const own = plotChart(two({ x: "E" }), sec, size);
  const at = (plot: typeof own, ml: number) => {
    const [uv] = plot.series;
    return uv.points.reduce((best, p) => (Math.abs(p.x - ml) < Math.abs(best.x - ml) ? p : best)).px;
  };

  it("against the UV volume, conductivity is squeezed into its first 6 ml", () => {
    const cond = shared.series[1];
    expect(cond.points).toHaveLength(241);
    expect(Math.max(...cond.points.map((p) => p.x))).toBeCloseTo(6, 1);
  });

  it("against its own, it runs the whole 24 ml and lines up with UV at the same volume", () => {
    const cond = own.series[1];
    expect(cond.ownX).toBe(true);
    expect(cond.points).toHaveLength(241);
    expect(Math.max(...cond.points.map((p) => p.x))).toBeCloseTo(24, 1);
    for (const ml of [0, 8.6, 13.4, 20]) {
      const c = cond.points.reduce((best, p) => (Math.abs(p.x - ml) < Math.abs(best.x - ml) ? p : best));
      expect(Math.abs(c.px - at(own, ml))).toBeLessThan(1);
    }
  });

  it("reads both at one place along x: UV by its row, conductivity by its nearest point", () => {
    const peak = own.stops.find((s) => s.row === 13.4 / 0.025);
    if (peak === undefined) throw new Error("no stop at 13.4 ml");
    const uv = pointAt(own.series[0], peak, 12);
    const cond = pointAt(own.series[1], peak, 12);
    expect(uv?.x).toBeCloseTo(13.4, 3);
    expect(cond?.x).toBeCloseTo(13.4, 1);
  });
});

describe("a time axis", () => {
  const log = plotChart(
    spec({ x: { column: "A", title: "Timestamp", unit: "", min: null, max: null }, series: [{ column: "E", name: "OD600", color: "blue", error: null }] }),
    bioreactor,
    size,
  );

  it("ticks the bioreactor's three days at hours and midnights, and reads out dates", () => {
    expect(log.xTicks.map((t) => t.label)).toContain("Nov 12");
    expect(log.xTicks.every((t) => /^(\d{2}:\d{2}|Nov \d+)$/.test(t.label))).toBe(true);
    expect(log.stops[0].label).toBe("Nov 10, 2026, 09:00");
    expect(log.xTitle?.text).toBe("Timestamp");
  });
});

describe("twelve lines", () => {
  const series: Series[] = [];
  for (const c of kinetic.columns.slice(2, 14)) series.push({ column: c.id, name: c.name, ...nextStyle(series, "line"), error: null, x: null });
  const plot = plotChart(spec({ x: { column: "A", title: "Time", unit: "min", min: null, max: null }, series }), kinetic, size);

  it("draws the second six dashed, with hollow markers in the legend", () => {
    expect(plot.series).toHaveLength(12);
    expect(plot.series.slice(6).every((s) => s.stroke === "dashed")).toBe(true);
    expect(plot.legend.map((l) => `${l.color} ${l.stroke}`)).toContain("blue dashed");
    expect(new Set(plot.legend.map((l) => `${l.color} ${l.stroke}`)).size).toBe(12);
    expect(plot.series.every((s) => s.label === null)).toBe(true);
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
