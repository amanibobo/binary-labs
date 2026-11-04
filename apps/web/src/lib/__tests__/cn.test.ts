import { describe, expect, it } from "vitest";
import { cn } from "../cn";

describe("cn", () => {
  it("keeps a token text color next to a Base type-scale size", () => {
    expect(cn("text-content-inverse-primary", "text-label-medium")).toBe("text-content-inverse-primary text-label-medium");
  });

  it("still lets a later size or color win over an earlier one", () => {
    expect(cn("text-label-medium text-content-primary", "text-paragraph-small text-content-tertiary")).toBe(
      "text-paragraph-small text-content-tertiary",
    );
  });
});
