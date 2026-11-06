import { describe, expect, it } from "vitest";
import bradfordJson from "@/fixtures/tables/Bradford_2026-10-30.json";
import bradfordPlateJson from "@/fixtures/tables/Bradford_plate_2026-11-05.json";
import cellsJson from "@/fixtures/tables/cell_sizes.json";
import growthJson from "@/fixtures/tables/growth_curve.json";
import knockdownJson from "@/fixtures/tables/knockdown_qpcr.json";
import pendulumJson from "@/fixtures/tables/pendulum.json";
import groupsJson from "@/fixtures/tables/treatments_4groups.json";
import doseLayoutJson from "@/fixtures/tables/viability_drugA_layout.json";
import doseJson from "@/fixtures/tables/viability_drugA.json";
import { analyze, analyzeCurve, analyzeDose, analyzeGroups, analyzeHistogram, runTest, type GroupStat } from "../analysis";
import { ChartSpec } from "../charts";
import { DataTables, mainTable } from "../data-tables";
import { layoutFromFile } from "../layouts";
import { describeSummary, startKind, summarySuggestions, summaryWarnings, type ChartData } from "../summary-guide";
import { welch } from "../stats";

// The guide and the analysis on the round's fixture exports (workers/scripts/make_table_fixtures.py):
// what's suggested, how each chart starts, and the numbers and words it gives.

function data(json: unknown, sheet?: string): ChartData {
  const doc = DataTables.parse(json);
  const table = sheet === undefined ? mainTable(doc) : doc.tables.find((t) => t.name === sheet);
  if (table === null || table === undefined) throw new Error("no table");
  const found = layoutFromFile(doc, table);
  return { table, tables: doc.tables, layout: found === null ? null : { ...found, layoutId: null } };
}

const ofType = <T extends ChartSpec["type"]>(spec: ChartSpec | null, type: T): spec is Extract<ChartSpec, { type: T }> => spec?.type === type;

function start<T extends ChartSpec["type"]>(d: ChartData, kind: Parameters<typeof startKind>[1], type: T): Extract<ChartSpec, { type: T }> {
  const spec = startKind(d, kind);
  if (!ofType(spec, type)) throw new Error(`expected a ${type}, got ${spec?.type ?? "nothing"}`);
  // Every started chart is a valid spec.
  expect(ChartSpec.safeParse(spec).success).toBe(true);
  return spec;
}

const kinds = (d: ChartData) => summarySuggestions(d).map((s) => s.kind);

describe("a dose-response plate with its layout in the export", () => {
  const d = data(doseLayoutJson);
  it("reads the layout block and the concentrations", () => {
    expect(d.layout?.from).toBe("the layout in Table 2 and the concentrations in Table 3");
    const groups = d.layout?.layout.groups.map((g) => [g.role, g.name, g.conc, g.wells.join(" ")]);
    expect(groups).toEqual([
      ["blank", "", null, "B1 C1 D1"],
      ["control", "", 0, "B2 C2 D2"],
      ["sample", "Drug A", 100, "B3 C3 D3"],
      ["sample", "Drug A", 20, "B4 C4 D4"],
      ["sample", "Drug A", 4, "B5 C5 D5"],
      ["sample", "Drug A", 0.8, "B6 C6 D6"],
      ["sample", "Drug A", 0.16, "B7 C7 D7"],
    ]);
    expect(d.layout?.layout.unit).toBe("µM");
  });
  it("suggests a dose-response first, and finds the IC50 with its 95% range", () => {
    expect(kinds(d)[0]).toBe("dose");
    const spec = start(d, "dose", "dose");
    expect(spec.blank).toBe(true);
    const a = analyzeDose(d.table, spec);
    const [drug] = a.series;
    expect(drug?.term).toBe("IC50");
    expect(drug?.verdict.kind).toBe("ok");
    if (drug?.verdict.kind !== "ok") return;
    // The plate was made with an IC50 of 2.4 µM.
    expect(drug.verdict.mid).toBeGreaterThan(2.1);
    expect(drug.verdict.mid).toBeLessThan(2.7);
    expect(drug.verdict.ci[0]).toBeLessThan(drug.verdict.mid);
    expect(drug.verdict.ci[1]).toBeGreaterThan(drug.verdict.mid);
    expect(describeSummary(spec, d, a)).toMatch(/^A570 for 5 doses of Drug A from 0\.16 to 100 µM, 3 wells each, fitted with a four-parameter curve; IC50 2\.\d+ µM \(2\.\d+ to 2\.\d+\)\. The blank \(mean of 3 wells\) is taken off every reading\./);
  });
  it("fits the means when asked, with fewer degrees of freedom and a wider range", () => {
    const spec = start(d, "dose", "dose");
    const every = analyzeDose(d.table, spec).series[0]?.fit;
    const means = analyzeDose(d.table, { ...spec, fit: "means" }).series[0]?.fit;
    expect(every?.kind === "fit" && every.df).toBe(11);
    expect(means?.kind === "fit" && means.df).toBe(1);
  });
  it("compares each dose with the control as bars", () => {
    const spec = start(d, "bar", "groups");
    expect(spec.test).toBe("control");
    const a = analyzeGroups(d.table, spec);
    expect(a.groups.map((g) => g.label)).toEqual(["Control", "Drug A 0.16 µM", "Drug A 0.8 µM", "Drug A 4 µM", "Drug A 20 µM", "Drug A 100 µM"]);
    expect(a.caption[0]).toMatch(/^Each group against Control: Welch's t-tests, Holm-corrected\./);
  });
});

describe("the same plate exported without a layout", () => {
  const d = data(doseJson);
  it("opens as the plate and says what to mark first", () => {
    expect(d.layout).toBeNull();
    expect(kinds(d)).toEqual([]);
    expect(startKind(d, "dose")).toBeNull();
  });
});

describe("a Bradford plate with standards, blanks and samples", () => {
  const d = data(bradfordPlateJson);
  const spec = start(d, "scatter", "curve");
  const a = analyzeCurve(d.table, spec, d.tables);
  it("suggests a standard curve that reads the samples", () => {
    expect(summarySuggestions(d)[0]?.reason).toBe("Your layout has 5 standards from 125 to 1,000 µg/mL, so a standard curve reads your 4 samples off it.");
    expect(spec.blank).toBe(true);
    expect(spec.unknowns).toEqual({ kind: "layout" });
  });
  it("reads each sample within a few percent of what was pipetted, times its dilution", () => {
    const byName = new Map(a.unknowns.map((u) => [u.label, u]));
    // The fixture's samples were made at 640, 310, 42 and 1250 µg/mL in the well.
    expect(byName.get("Lysate")?.conc).toBeCloseTo(640, -2);
    expect(byName.get("Lysate")?.original).toBeCloseTo((byName.get("Lysate")?.conc ?? 0) * 20, 6);
    expect(byName.get("Flow-through")?.conc).toBeCloseTo(310, -1);
    expect(byName.get("Wash")?.outside).toBe("below");
    expect(byName.get("Elution 1")?.outside).toBe("above");
    expect(a.warnings).toContain("Elution 1 reads above your highest standard, outside your standards, so its number is a guess. Dilute it more and read it again.");
  });
  it("puts the blank's mean in the sentence and the line through the means", () => {
    expect(a.blank?.n).toBe(3);
    expect(a.fit?.r2).toBeGreaterThan(0.99);
    expect(describeSummary(spec, d, a)).toContain("The blank (mean of 3 wells) is taken off every reading. 4 samples are read off the line, 2 outside your standards.");
  });
  it("can be forced through zero, which is where a blank-subtracted curve should go", () => {
    const origin = analyzeCurve(d.table, { ...spec, fit: "origin" }, d.tables);
    expect(origin.fit?.intercept).toBe(0);
    expect(origin.facts[0]?.answer).toMatch(/^y = 0\.000\d+x$/);
  });
});

describe("the Bradford workbook", () => {
  const d = data(bradfordJson, "Standards");
  it("computes the means from the repeats, not the Mean column, and reads the Samples sheet", () => {
    const spec = start(d, "scatter", "curve");
    expect(spec.source.kind).toBe("rows");
    expect(spec.unknowns?.kind).toBe("table");
    const a = analyzeCurve(d.table, spec, d.tables);
    const mean = d.table.columns.find((c) => c.name === "Mean");
    // The sheet's own mean was rounded to 4 places; the computed one matches it to that.
    a.standards.forEach((g, i) => expect(g.summary.mean).toBeCloseTo(mean?.kind === "number" ? (mean.values[i] ?? 0) : 0, 3));
    expect(a.unknowns).toHaveLength(7);
    expect(a.warnings.some((w) => w.startsWith("R² is 0.942"))).toBe(true);
  });
});

describe("two groups: knockdown vs control, n = 4", () => {
  const d = data(knockdownJson);
  it("suggests bars with Welch's t-test, matching SciPy's p", () => {
    expect(kinds(d)).toEqual(["bar", "box"]);
    const spec = start(d, "bar", "groups");
    expect(spec.test).toBe("welch");
    expect(spec.points).toBe(true);
    const a = analyzeGroups(d.table, spec);
    if (a.test.kind !== "welch") throw new Error(a.test.kind);
    const reference = welch([1.02, 0.96, 1.08, 0.94], [0.61, 0.55, 0.72, 0.58]);
    expect(reference.kind === "ok" && a.test.result.p).toBeCloseTo(reference.kind === "ok" ? reference.p : 0, 12);
    expect(a.facts.find((f) => f.question === "Is the difference real?")?.answer).toBe("Welch's t-test, p = 0.0002");
    expect(a.caption[0]).toMatch(/^Control siRNA vs SOX2 siRNA: Welch's t-test, t = \S+, df = \S+, p = 0\.0002; n = 4 and 4\.$/);
  });
  it("switches SD to SEM and 95% CI from the same repeats", () => {
    const spec = start(d, "bar", "groups");
    const [sd, sem, ci] = (["sd", "sem", "ci"] as const).map((spread) => analyzeGroups(d.table, { ...spec, spread }).groups[0]?.half ?? 0);
    expect(sem).toBeCloseTo(sd / 2, 12);
    // t(0.975, 3) = 3.182
    expect(ci / sem).toBeCloseTo(3.18245, 4);
  });
});

describe("four groups in long format", () => {
  const d = data(groupsJson);
  const spec = start(d, "bar", "groups");
  it("compares each with the vehicle, Holm-corrected", () => {
    expect(spec.test).toBe("control");
    expect(spec.control).toBe("Vehicle");
    const a = analyzeGroups(d.table, spec);
    expect(a.test.kind).toBe("control");
  });
  it("offers ANOVA instead, and says when it was picked by hand", () => {
    const a = analyzeGroups(d.table, { ...spec, test: "anova" });
    expect(a.test.kind).toBe("anova");
    expect(a.warnings.some((w) => w.startsWith("One-way ANOVA is picked by hand."))).toBe(true);
  });
  it("refuses a two-group test on four groups", () => {
    const a = analyzeGroups(d.table, { ...spec, test: "welch" });
    expect(a.test).toEqual({ kind: "cannot", test: "welch", reason: "Welch's t-test compares exactly 2 groups, and this chart has 4." });
  });
  it("warns when a group has fewer than 3 repeats", () => {
    const groups: GroupStat[] = analyzeGroups(d.table, spec).groups.map((g, i) => (i === 1 ? { ...g, repeats: g.repeats.slice(0, 2), summary: { ...g.summary, n: 2 } } : g));
    expect(runTest(groups, "control", "Vehicle").kind).toBe("control");
  });
});

describe("a growth curve with repeats", () => {
  const d = data(growthJson);
  it("suggests a line with its spread as a band, one line per strain", () => {
    expect(kinds(d)[0]).toBe("line");
    const spec = start(d, "line", "band");
    const a = analyze(d.table, spec);
    if (a.kind !== "band") throw new Error(a.kind);
    expect(a.series.map((s) => [s.name, s.groups.length])).toEqual([
      ["Wild type", 13],
      ["ΔsigB", 13],
    ]);
    expect(describeSummary(spec, d, a)).toBe("Wild type and ΔsigB as Time goes from 0 to 12 h, 13 points, each the mean of 3 repeats, with a shaded band showing how much the repeats vary (SD).");
  });
  it("never offers time as a dose", () => {
    expect(startKind(d, "dose")).toBeNull();
  });
});

describe("200 cell sizes", () => {
  const d = data(cellsJson);
  it("suggests a histogram and says how its bins were chosen", () => {
    expect(kinds(d)[0]).toBe("histogram");
    const spec = start(d, "histogram", "histogram");
    const a = analyzeHistogram(d.table, spec);
    expect(a.counts.reduce((s, c) => s + c, 0)).toBe(200);
    expect(a.rule).toMatch(/^Bins 1 µm wide, from the Freedman–Diaconis rule \(2 × IQR ÷ ∛n = \d\.\d+\), rounded to a round number\.$/);
    const wider = analyzeHistogram(d.table, { ...spec, bin: 2 });
    expect(wider.rule).toBe("Bins 2 µm wide, set by hand.");
  });
});

describe("a pendulum, not biology", () => {
  const d = data(pendulumJson);
  it("fits a straight line whose slope is 4π²/g", () => {
    expect(kinds(d)).toEqual(["scatter"]);
    const spec = start(d, "scatter", "curve");
    const a = analyzeCurve(d.table, { ...spec, fit: "origin" });
    const g = (4 * Math.PI ** 2) / (a.fit?.slope ?? 1);
    expect(g).toBeGreaterThan(9.6);
    expect(g).toBeLessThan(10);
    expect(a.facts.some((f) => f.question === "What do the error bars show?")).toBe(false);
  });
});

describe("honest refusals", () => {
  const d = data(doseLayoutJson);
  const spec = start(d, "dose", "dose");
  it("too few concentrations", () => {
    const layout = d.layout?.layout;
    if (layout === undefined || spec.source.kind !== "plate") throw new Error("no layout");
    const fewer = { ...layout, groups: layout.groups.filter((g) => g.conc !== 0.16 && g.conc !== 0.8) };
    const a = analyzeDose(d.table, { ...spec, source: { ...spec.source, layout: fewer } });
    expect(a.series[0]?.verdict).toEqual({ kind: "none", reason: "A four-parameter curve needs at least 5 concentrations, and Drug A has 3, so there's no IC50 to give." });
    expect(describeSummary({ ...spec, source: { ...spec.source, layout: fewer } }, d)).toContain("no curve could be given");
  });
  it("hidden repeats are pointed out", () => {
    const groups = start(d, "bar", "groups");
    expect(summaryWarnings({ ...groups, points: false }, d)).toContain("Every repeat is hidden. With 10 or fewer, showing them lets a reader judge the spread for themselves.");
  });
});
