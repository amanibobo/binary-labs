import { describe, expect, it } from "vitest";
import { SearchFilesRows } from "../domain";
import { matchesFilters } from "../filters";

const [hit] = SearchFilesRows.parse([
  {
    sha256: "c".repeat(64),
    score: 1,
    keyword_rank: null,
    vector_rank: null,
    snippet: null,
    file_kind: "pdf",
    mime: "application/pdf",
    size: 1,
    has_preview: false,
    locations: [
      {
        id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0002",
        source_id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003",
        source_kind: "dropbox",
        path: "/Lab/Protocols/SEC.pdf",
        original_name: "SEC.pdf",
        modified_at: "2026-10-14T23:30:00+00:00",
      },
    ],
  },
]);

describe("matchesFilters", () => {
  if (hit === undefined) throw new Error("fixture did not parse");
  it("passes with no filters and checks each filter", () => {
    expect(matchesFilters(hit, {})).toBe(true);
    expect(matchesFilters(hit, { kind: "pdf" })).toBe(true);
    expect(matchesFilters(hit, { kind: "image" })).toBe(false);
    expect(matchesFilters(hit, { prefix: "/lab/protocols" })).toBe(true);
    expect(matchesFilters(hit, { prefix: "/Lab/Gels" })).toBe(false);
  });

  it("treats the date range as whole days, inclusive on both ends", () => {
    expect(matchesFilters(hit, { from: "2026-10-14", to: "2026-10-14" })).toBe(true);
    expect(matchesFilters(hit, { from: "2026-10-15" })).toBe(false);
    expect(matchesFilters(hit, { to: "2026-10-13" })).toBe(false);
  });

  it("compares in UTC whatever offset the timestamp carries", () => {
    const [first] = hit.locations;
    const shifted = { ...hit, locations: [{ ...first, modifiedAt: "2026-10-14T21:30:00-04:00" }] } satisfies typeof hit;
    expect(matchesFilters(shifted, { to: "2026-10-14" })).toBe(false);
    expect(matchesFilters(shifted, { from: "2026-10-15", to: "2026-10-15" })).toBe(true);
  });
});
