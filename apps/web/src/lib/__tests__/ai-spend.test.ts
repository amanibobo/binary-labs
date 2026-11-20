import { describe, expect, it } from "vitest";
import { AiCapInput, dollars, spendText } from "../ai-spend";

const resetsAt = "2026-12-01T00:00:00Z";

describe("the monthly AI limit in plain words", () => {
  it("says what's used against the limit and when it starts again", () => {
    expect(spendText({ capUsd: 25, spentUsd: 3.2, resetsAt })).toBe("$3.20 of $25 used this month. It starts again on December 1.");
    expect(spendText({ capUsd: 25, spentUsd: 0, resetsAt })).toBe("$0 of $25 used this month. It starts again on December 1.");
    expect(spendText({ capUsd: 10, spentUsd: 0.004, resetsAt })).toBe("Less than $0.01 of $10 used this month. It starts again on December 1.");
  });

  it("says when the limit is reached or off", () => {
    expect(spendText({ capUsd: 25, spentUsd: 25.01, resetsAt })).toBe("The lab has used all of this month's $25. Asking starts again on December 1.");
    expect(spendText({ capUsd: 0, spentUsd: 0, resetsAt })).toBe("The limit is $0, so asking the lab and suggestions are off.");
  });

  it("formats cents and whole dollars", () => {
    expect([dollars(12.5), dollars(40), dollars(0)]).toEqual(["$12.50", "$40", "$0"]);
  });

  it("takes a limit from $0 to $1000", () => {
    expect(AiCapInput.parse("12.5")).toBe(12.5);
    expect(AiCapInput.safeParse("-1").success).toBe(false);
    expect(AiCapInput.safeParse("1001").success).toBe(false);
    expect(AiCapInput.safeParse("ten").success).toBe(false);
  });
});
