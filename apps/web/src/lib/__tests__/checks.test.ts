import { describe, expect, it } from "vitest";
import {
  CheckSpec,
  CheckSpecs,
  holds,
  measureText,
  newDraft,
  parseDraft,
  rangeText,
  readNumber,
  ruleText,
  SaveChecksRequest,
  toDraft,
  usefulText,
  valueTerm,
  withFit,
  withMeasure,
  type CheckDraft,
} from "../checks";
import { CheckId } from "../ids";

const id = CheckId.parse("0f8f2c1e-0001-4a4e-8c55-0c3c1a7a0001");
const other = CheckId.parse("0f8f2c1e-0002-4a4e-8c55-0c3c1a7a0002");

const curve = { id, name: "Standard curve fit", kind: "curve_fit", sheet: null, unit: null, range: { kind: "at_least", min: 0.98 }, x: null, y: null };
const blank = {
  id: other,
  name: "Blanks",
  kind: "control",
  sheet: null,
  unit: "AU",
  range: { kind: "at_most", max: 0.1 },
  pattern: "blank",
  labelColumn: null,
  column: "A595",
  use: "each",
};

describe("the check spec", () => {
  it("takes the four kinds the database takes", () => {
    const specs = [
      curve,
      { ...curve, id: other, kind: "peak", unit: "nm", range: { kind: "around", target: 280, tolerance: 2 } },
      { ...curve, kind: "value", x: undefined, y: undefined, column: "260/280", stat: "cell", row: "BM3 pool" },
      blank,
    ].map((s) => JSON.parse(JSON.stringify(s)));
    for (const s of specs) expect(CheckSpec.safeParse(s).success, JSON.stringify(s)).toBe(true);
  });

  it("refuses what check_spec_ok refuses", () => {
    const bad = [
      { ...curve, range: { kind: "at_least" } },
      { ...curve, range: { kind: "between", min: 2, max: 1 } },
      { ...curve, range: { kind: "around", target: 280, tolerance: -1 } },
      { ...curve, range: { kind: "at_least", min: 0.98, max: 1 } },
      { ...curve, kind: "pie" },
      { ...curve, name: "  " },
      { ...curve, x: undefined },
      { ...blank, pattern: "" },
      { ...curve, kind: "value", column: "A595", stat: "cell", row: null },
      { ...curve, kind: "value", column: "A595", stat: "mean", row: "BM3" },
      { ...curve, id: "not-a-uuid" },
    ].map((s) => JSON.parse(JSON.stringify(s)));
    for (const s of bad) expect(CheckSpec.safeParse(s).success, JSON.stringify(s)).toBe(false);
    expect(CheckSpecs.safeParse([curve, curve]).success).toBe(false);
  });

  it("reads a save request with an empty note as none", () => {
    const req = SaveChecksRequest.parse({ baseVersionId: "7b1c2c39-5a4e-4c55-9d7b-0c3c1a7b0003", checks: [curve], note: "  " });
    expect(req.note).toBeNull();
  });
});

describe("what a check says", () => {
  it("names ranges and measures in plain words", () => {
    expect(rangeText({ kind: "at_least", min: 0.98 }, null)).toBe("at least 0.98");
    expect(rangeText({ kind: "around", target: 280, tolerance: 2 }, "nm")).toBe("280 ± 2 nm");
    expect(rangeText({ kind: "between", min: 0.1, max: 1 }, "AU")).toBe("0.1 to 1 AU");
    expect(ruleText(CheckSpec.parse(curve))).toBe("R² of the standard curve: at least 0.98");
    expect(ruleText(CheckSpec.parse(blank))).toBe("Every “blank” row in “A595”: at most 0.1 AU");
    const cell = JSON.parse(JSON.stringify({ ...curve, kind: "value", x: undefined, y: undefined, column: "260/280", stat: "cell", row: "BM3 pool" }));
    expect(measureText(CheckSpec.parse(cell))).toBe(
      "“260/280” in row “BM3 pool”",
    );
  });

  it("holds ranges at their edges like the worker", () => {
    expect(holds({ kind: "at_least", min: 0.98 }, 0.98)).toBe(true);
    expect(holds({ kind: "around", target: 280, tolerance: 2 }, 282.5)).toBe(false);
    expect(holds({ kind: "between", min: 1, max: 2 }, 2)).toBe(true);
  });

  it("gives admins each check's answer rate", () => {
    expect(usefulText({ flags: 0, useful: 0, wrong: 0, knownIssue: 0 })).toBe("No flags yet");
    expect(usefulText({ flags: 2, useful: 0, wrong: 0, knownIssue: 0 })).toBe("2 flags, none answered yet");
    expect(usefulText({ flags: 6, useful: 4, wrong: 0, knownIssue: 1 })).toBe("80% useful · 4 useful, 0 wrong, 1 known issue");
  });
});

describe("the editor's drafts", () => {
  it("round-trips every saved check", () => {
    for (const s of [curve, blank]) {
      const check = CheckSpec.parse(s);
      const parsed = parseDraft(toDraft(check));
      expect(parsed).toEqual({ kind: "ok", check });
    }
  });

  it("starts each kind with a range a lab would use", () => {
    const fit = parseDraft({ ...newDraft("curve_fit", id) });
    expect(fit.kind === "ok" && ruleText(fit.check)).toBe("R² of the standard curve: at least 0.98");
    const peak = parseDraft(newDraft("peak", id));
    expect(peak.kind === "ok" && ruleText(peak.check)).toBe("Where the highest reading sits: 280 ± 2 nm");
  });

  it("says which field is wrong", () => {
    const value: CheckDraft = { ...newDraft("value", id), name: "Ratio" };
    expect(parseDraft(value)).toMatchObject({ kind: "invalid", field: "range" });
    expect(parseDraft({ ...value, range: { kind: "between", a: "1", b: "2" } })).toMatchObject({ kind: "invalid", field: "column" });
    expect(parseDraft({ ...value, column: "260/280", stat: "cell", range: { kind: "at_most", a: "0.6", b: "" } })).toMatchObject({
      kind: "invalid",
      field: "row",
    });
    expect(parseDraft({ ...value, column: "x", range: { kind: "between", a: "3", b: "2" } })).toEqual({
      kind: "invalid",
      field: "range",
      message: "The lower end goes first.",
    });
    expect(parseDraft({ ...newDraft("control", id), pattern: " " })).toMatchObject({ kind: "invalid", field: "pattern" });
  });

  it("reads numbers as people type them", () => {
    expect(readNumber(" 1,000 ")).toBe(1000);
    expect(readNumber("1e-3")).toBe(0.001);
    expect(readNumber(".5")).toBe(0.5);
    expect(readNumber("0.98abc")).toBeNull();
    expect(readNumber("")).toBeNull();
  });
});

describe("curve fits and controls by column", () => {
  const ic50 = { ...curve, name: "Drug A IC50", range: { kind: "between", min: 1, max: 5 }, fit: "4pl", measure: "midpoint" };
  const columns = { ...blank, by: "column", column: null };

  it("reads a check saved before the choice as a line's R² and controls by row", () => {
    expect(CheckSpec.parse(curve)).toMatchObject({ fit: "line", measure: "r2" });
    expect(CheckSpec.parse(blank)).toMatchObject({ by: "row" });
  });

  it("takes the shapes the database takes and refuses the ones it refuses", () => {
    for (const s of [ic50, columns, { ...curve, fit: "log_line", measure: "r2" }, { ...curve, fit: "line", measure: "outside" }]) {
      expect(CheckSpec.safeParse(s).success, JSON.stringify(s)).toBe(true);
    }
    for (const s of [
      { ...ic50, fit: "line" },
      { ...curve, fit: "4pl", measure: "outside" },
      { ...curve, fit: "spline", measure: "r2" },
      { ...columns, column: "A595" },
      { ...columns, labelColumn: "Sample" },
      { ...columns, by: "cell" },
      { ...blank, by: "row", column: null },
    ]) {
      expect(CheckSpec.safeParse(s).success, JSON.stringify(s)).toBe(false);
    }
  });

  it("says what each reads in plain words", () => {
    expect(ruleText(CheckSpec.parse(ic50))).toBe("IC50 or EC50 of the dose-response curve: 1 to 5");
    expect(ruleText(CheckSpec.parse({ ...curve, fit: "log_line", measure: "r2", x: "Quantity", y: "Ct" }))).toBe(
      "R² of the standard curve on a log scale (“Ct” against “Quantity”): at least 0.98",
    );
    expect(ruleText(CheckSpec.parse({ ...curve, measure: "outside", range: { kind: "at_most", max: 0 } }))).toBe("Samples outside the standards: at most 0");
    expect(ruleText(CheckSpec.parse(columns))).toBe("Every “blank” column: at most 0.1 AU");
    expect(valueTerm(CheckSpec.parse(ic50))).toBe("IC50 or EC50");
    expect(valueTerm(CheckSpec.parse(curve))).toBe("R² of the fit");
  });

  it("round-trips through the editor, and drops what a choice doesn't use", () => {
    for (const s of [ic50, columns]) {
      const check = CheckSpec.parse(s);
      expect(parseDraft(toDraft(check))).toEqual({ kind: "ok", check });
    }
    // Switched back to a line, an IC50 check reads the R²; switched to columns, the names go.
    const line = parseDraft({ ...toDraft(CheckSpec.parse(ic50)), fit: "line" });
    expect(line.kind === "ok" && line.check.kind === "curve_fit" && line.check.measure).toBe("r2");
    const byColumn = parseDraft({ ...toDraft(CheckSpec.parse({ ...blank, labelColumn: "Sample" })), by: "column" });
    expect(byColumn.kind === "ok" && byColumn.check).toMatchObject({ by: "column", column: null, labelColumn: null });
    expect(parseDraft({ ...newDraft("control", id), column: "" })).toMatchObject({ kind: "invalid", field: "column" });
    expect(parseDraft({ ...newDraft("control", id), by: "column", column: "" }).kind).toBe("ok");
  });

  it("starts an IC50 or a samples check with its own name and range, keeping what was typed", () => {
    const fresh = withMeasure(withFit(newDraft("curve_fit", id), "4pl"), "midpoint");
    expect(fresh).toMatchObject({ fit: "4pl", measure: "midpoint", name: "IC50", range: { kind: "between", a: "", b: "" } });
    const typed = withMeasure({ ...newDraft("curve_fit", id), name: "BSA curve", range: { kind: "at_least", a: "0.99", b: "" } }, "outside");
    expect(typed).toMatchObject({ measure: "outside", name: "BSA curve", range: { kind: "at_least", a: "0.99" } });
    expect(withMeasure(newDraft("curve_fit", id), "outside")).toMatchObject({ name: "Samples within the standards", range: { kind: "at_most", a: "0" } });
    // A line can't give an IC50, so leaving the 4PL goes back to the R² and its range.
    expect(withFit({ ...newDraft("curve_fit", id), ...fresh }, "log_line")).toMatchObject({ fit: "log_line", measure: "r2", name: "Standard curve fit", range: { a: "0.98" } });
  });
});
