import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import doseJson from "@/fixtures/tables/viability_drugA.json";
import { DataTables, mainTable } from "../data-tables";
import { fitDose, mean } from "../stats";

// The answers the worker's fits (workers/tests/test_fits.py) are held to as well, so a check's
// IC50 and the chart's are the same number.
const Answers = z.object({
  workedExample: z.object({
    plateRows: z.array(z.string()),
    blankColumn: z.string(),
    doses: z.record(z.string(), z.number()),
    blank: z.number(),
    ic50: z.number(),
    ciLow: z.number(),
    ciHigh: z.number(),
    hill: z.number(),
    top: z.number(),
    bottom: z.number(),
  }),
});
const { workedExample: answer } = Answers.parse(JSON.parse(readFileSync(join(__dirname, "fit-answers.json"), "utf8")));

const sig = (x: number) => Number(x.toPrecision(3));

describe("the worked example's fit", () => {
  const table = mainTable(DataTables.parse(doseJson));
  if (table === null) throw new Error("no plate");
  const named = (name: string) => {
    const c = table.columns.find((col) => col.name === name);
    if (c === undefined) throw new Error(`no column ${name}`);
    return c;
  };
  const letters = named("Column A").values;
  const read = (column: string, letter: string) => {
    const v = named(column).values[letters.indexOf(letter)];
    if (typeof v !== "number") throw new Error(`${letter}${column} isn't a number`);
    return v;
  };
  const blank = mean(answer.plateRows.map((r) => read(answer.blankColumn, r)));
  const wells = Object.entries(answer.doses).flatMap(([column, dose]) => answer.plateRows.map((r) => ({ x: Math.log10(dose), y: read(column, r) - blank })));

  it("gives the IC50, its range and the slope the worker gives", () => {
    expect(sig(blank)).toBe(answer.blank);
    const fit = fitDose(
      wells.map((w) => w.x),
      wells.map((w) => w.y),
    );
    if (fit.kind !== "fit" || fit.logMidCi === null) throw new Error(`no fit: ${fit.kind}`);
    expect(sig(10 ** fit.params.logMid)).toBe(answer.ic50);
    expect([sig(10 ** fit.logMidCi[0]), sig(10 ** fit.logMidCi[1])]).toEqual([answer.ciLow, answer.ciHigh]);
    expect([sig(fit.params.hill), sig(fit.params.top), sig(fit.params.bottom)]).toEqual([answer.hill, answer.top, answer.bottom]);
  });
});
