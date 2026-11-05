import { describe, expect, it } from "vitest";
import { formatDay, formatInstant } from "../format";

describe("dates", () => {
  it("shows a calendar day as that day", () => {
    expect(formatDay("2026-10-14")).toBe("Oct 14, 2026");
  });

  it("shows a moment on the reader's own day", () => {
    // 10:19 pm on Nov 4 in New York is already Nov 5 in UTC.
    expect(formatInstant("2026-11-05T03:19:00Z", "America/New_York")).toBe("Nov 4, 2026");
    expect(formatInstant("2026-11-05T03:19:00Z", "UTC")).toBe("Nov 5, 2026");
  });
});
