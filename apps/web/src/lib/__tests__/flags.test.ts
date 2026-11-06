import { describe, expect, it } from "vitest";
import { excerptRows } from "@/components/flags/flag-table";
import { fixtureFlags } from "@/fixtures/flags";
import { FlagWire, inSpans, queueOrder, ReviewRequest, rowsText } from "../flags";

describe("flags", () => {
  it("parse from lab_flags rows and survive the wire", () => {
    for (const flag of fixtureFlags) expect(FlagWire.parse(JSON.parse(JSON.stringify(flag)))).toEqual(flag);
    const control = fixtureFlags.find((f) => f.kind === "control");
    expect(control?.control?.rows).toEqual([[0, 2]]);
  });

  it("queue unanswered flags first, newest first, and answered ones after", () => {
    const { waiting, answered } = queueOrder(fixtureFlags);
    expect(waiting.map((f) => f.checkName)).toEqual(["Blanks", "Standard curve fit"]);
    expect(answered.map((f) => f.answer?.review)).toEqual(["useful"]);
    const cleared = { ...fixtureFlags[0]!, state: { kind: "cleared" as const, at: "2026-11-05T00:00:00Z", reason: "It passes now." } };
    expect(queueOrder([cleared]).waiting).toEqual([]);
  });

  it("say rows the way a spreadsheet numbers them", () => {
    expect(rowsText([[0, 7]])).toBe("rows 1–8");
    expect(rowsText([[40, 40]])).toBe("row 41");
    expect(rowsText([[0, 2], [4, 4]])).toBe("rows 1–3, 5");
    expect(inSpans([[3, 14]], 3)).toBe(true);
    expect(inSpans([[3, 14]], 2)).toBe(false);
  });

  it("take an answer with an optional note", () => {
    expect(ReviewRequest.parse({ review: "known_issue", note: "  " })).toEqual({ review: "known_issue", note: null });
    expect(ReviewRequest.safeParse({ review: "maybe", note: null }).success).toBe(false);
    expect(ReviewRequest.safeParse({ review: "wrong", note: "x".repeat(501) }).success).toBe(false);
  });
});

describe("the table under a flag", () => {
  it("shows the rows read with two either side and says what it skipped", () => {
    expect(excerptRows(961, [[535, 535]])).toEqual([
      { kind: "gap", from: 0, to: 532 },
      ...[533, 534, 535, 536, 537].map((index) => ({ kind: "row", index, used: index === 535 })),
      { kind: "gap", from: 538, to: 960 },
    ]);
    const all = excerptRows(8, [[0, 7]]);
    expect(all).toHaveLength(8);
    expect(all.every((r) => r.kind === "row" && r.used)).toBe(true);
    expect(excerptRows(15, [[0, 2]]).at(-1)).toEqual({ kind: "gap", from: 5, to: 14 });
  });

  it("caps a long run of rows", () => {
    expect(excerptRows(10_000, [[0, 9_999]]).filter((r) => r.kind === "row")).toHaveLength(60);
  });
});
