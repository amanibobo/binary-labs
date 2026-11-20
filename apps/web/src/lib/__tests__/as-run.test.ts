import { describe, expect, it } from "vitest";
import { purificationBody } from "@/fixtures/protocols";
import { changeTitle, planChanges, planState, readLines, writeLines, type PlanBodies } from "../as-run";
import { ProtocolId, ProtocolVersionId, UserId } from "../ids";
import type { PlanFields } from "../run-record";

const v2 = ProtocolVersionId.parse("7a1c2c39-5a4e-4c55-9d7b-0c3c1a7b0002");
const v4 = ProtocolVersionId.parse("7a1c2c39-5a4e-4c55-9d7b-0c3c1a7b0004");
const planned = { versionId: v4, protocolId: ProtocolId.parse("7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001"), title: "P450 BM3 purification", version: 4 };
const asRun = (body: string, basedOn: ProtocolVersionId | null = v4): PlanFields["asRun"] => ({ body, basedOn, by: UserId.parse("00000000-0000-4000-8000-00000000000b"), at: "2026-10-15T10:00:00Z" });
const bodies: PlanBodies = { planned: purificationBody, basedOn: { versionId: v4, title: planned.title, version: 4, body: purificationBody } };

// The as-run text a student's edits would leave: each step line changed by `edit`.
function editSteps(edit: (steps: string[]) => string[]): string {
  const lines = readLines(purificationBody);
  const steps = lines.filter((l) => l.kind === "step").map((l) => l.text);
  const next = edit(steps);
  const first = lines.findIndex((l) => l.kind === "step");
  const rest = lines.filter((l) => l.kind !== "step");
  rest.splice(first, 0, ...next.map((text) => ({ kind: "step" as const, lead: "", text, number: null })));
  return writeLines(rest);
}
const titles = (body: string) => (planChanges(purificationBody, body) ?? []).map(changeTitle);

describe("readLines and writeLines", () => {
  it("give back the protocol exactly when nothing is edited", () => {
    expect(writeLines(readLines(purificationBody))).toBe(purificationBody);
  });

  it("number the steps again in order once one is taken out", () => {
    const body = editSteps((steps) => steps.filter((_, i) => i !== 1));
    expect(body).toContain("1. Resuspend the pellet");
    expect(body).toContain("2. Spin the lysate");
    expect(body).not.toContain("Sonicate");
  });

  it("keep table rows, the quote and headings as they are, and read them as lines that aren't edited", () => {
    const kinds = readLines(purificationBody).map((l) => l.kind);
    expect(kinds.filter((k) => k === "fixed")).toHaveLength(5);
    expect(kinds.filter((k) => k === "heading")).toHaveLength(3);
    expect(kinds.filter((k) => k === "step")).toHaveLength(6);
  });
});

describe("planChanges", () => {
  it("finds nothing when only spacing and step numbers differ", () => {
    const loose = purificationBody.replace("1. Resuspend", "7) Resuspend").replace("\n\n## Steps", "\n\n\n## Steps").replace(" 5 min total", " 5 min total  ");
    expect(planChanges(purificationBody, loose)).toEqual([]);
  });

  it("says which step changed, with what it was and what it is now", () => {
    const body = editSteps((steps) => steps.map((s, i) => (i === 2 ? "Spin the lysate at 12,000 g for 20 min at 4 °C. Keep the supernatant." : s)));
    expect(planChanges(purificationBody, body)).toEqual([
      {
        kind: "changed",
        at: { kind: "step", number: 3 },
        was: "Spin the lysate at 15,000 g for 30 min at 4 °C. Keep the supernatant.",
        now: "Spin the lysate at 12,000 g for 20 min at 4 °C. Keep the supernatant.",
      },
    ]);
    expect(titles(body)).toEqual(["Step 3 changed"]);
  });

  it("names a step left out by the plan's number, without calling every later step changed", () => {
    expect(titles(editSteps((steps) => steps.filter((_, i) => i !== 1)))).toEqual(["Step 2 left out"]);
    expect(titles(editSteps((steps) => steps.slice(0, 5)))).toEqual(["Step 6 left out"]);
  });

  it("says where an added step went", () => {
    const body = editSteps((steps) => [...steps.slice(0, 2), "Rest the lysate on ice for 10 min.", "Check it's clear.", ...steps.slice(2)]);
    expect(planChanges(purificationBody, body)).toEqual([{ kind: "added", after: { kind: "step", number: 2 }, lines: ["Rest the lysate on ice for 10 min.", "Check it's clear."] }]);
    expect(titles(body)).toEqual(["Added after step 2"]);
    const first = editSteps((steps) => ["Chill the rotor.", ...steps]);
    expect(titles(first)).toEqual(["Added under “Steps”"]);
  });

  it("names a changed line outside the steps by the heading it's under", () => {
    const body = purificationBody.replace("on ice for 20 min", "on ice for 40 min");
    expect(titles(body)).toEqual(["Changed under “Before you start”"]);
    expect(titles(purificationBody.replace("Run this for every BM3 batch.", "Run this for most batches."))).toEqual(["Changed near the top"]);
  });

  it("pairs a changed step with what it became, not with a step added beside it", () => {
    const body = editSteps((steps) => [
      ...steps.slice(0, 2),
      "Rest the lysate on ice for 10 min.",
      "Spin the lysate at 10,000 g for 20 min at 4 °C. Keep the supernatant.",
      ...steps.slice(3),
    ]);
    expect(planChanges(purificationBody, body)).toEqual([
      { kind: "added", after: { kind: "step", number: 2 }, lines: ["Rest the lysate on ice for 10 min."] },
      {
        kind: "changed",
        at: { kind: "step", number: 3 },
        was: "Spin the lysate at 15,000 g for 30 min at 4 °C. Keep the supernatant.",
        now: "Spin the lysate at 10,000 g for 20 min at 4 °C. Keep the supernatant.",
      },
    ]);
    expect(titles(editSteps((steps) => steps.map((s, i) => (i === 2 ? "Centrifuge it." : s))))).toEqual(["Step 3 changed"]);
  });

  it("lists several changes in the plan's order", () => {
    const body = editSteps((steps) => [steps[0] ?? "", "Sonicate for 6 min.", ...steps.slice(2, 5)]);
    expect(titles(body)).toEqual(["Step 2 changed", "Step 6 left out"]);
  });
});

describe("planState", () => {
  it("is no plan, missing, or unplanned before there's something to compare", () => {
    expect(planState({ planned: null, asRun: null }, { planned: null, basedOn: null })).toEqual({ kind: "no_plan" });
    expect(planState({ planned, asRun: null }, bodies)).toEqual({ kind: "missing" });
    expect(planState({ planned: null, asRun: asRun("Did it my way.", null) }, { planned: null, basedOn: null })).toEqual({ kind: "unplanned", asRun: "Did it my way." });
  });

  it("is done as written, or the list of changes", () => {
    expect(planState({ planned, asRun: asRun(purificationBody) }, bodies)).toEqual({ kind: "as_written" });
    const body = purificationBody.replace("at 1 mL/min", "at 2 mL/min");
    expect(planState({ planned, asRun: asRun(body) }, bodies)).toMatchObject({ kind: "changed", changes: [{ at: { kind: "step", number: 4 } }] });
  });

  it("compares with the version the text started from, not one picked afterwards", () => {
    const older = purificationBody.replace("15,000 g for 30 min", "12,000 g for 20 min");
    const fromOlder: PlanBodies = { planned: purificationBody, basedOn: { versionId: v2, title: "P450 purification", version: 2, body: older } };
    expect(planState({ planned, asRun: asRun(older, v2) }, fromOlder)).toEqual({ kind: "as_written" });
    expect(planState({ planned, asRun: asRun(older, null) }, { planned: purificationBody, basedOn: null })).toMatchObject({ kind: "changed" });
  });

  it("shows both whole when too much differs to line up", () => {
    const a = Array.from({ length: 1500 }, (_, i) => `${i + 1}. Step a${i}`).join("\n");
    const b = Array.from({ length: 1500 }, (_, i) => `${i + 1}. Step b${i}`).join("\n");
    expect(planState({ planned, asRun: asRun(b) }, { planned: a, basedOn: { versionId: v4, title: "Long", version: 4, body: a } })).toEqual({ kind: "too_different", plan: a, asRun: b });
  });
});
