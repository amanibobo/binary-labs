import { describe, expect, it } from "vitest";
import {
  CorrectionRows,
  EmbedResponse,
  LabelRow,
  needsCheck,
  NeedsLookRows,
  LabMemberRows,
  ProgressRows,
  SearchFilesRows,
  SearchParams,
  SearchResponse,
} from "../domain";

const location = {
  id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0002",
  source_id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003",
  source_kind: "dropbox",
  path: "/Lab/final_v2_REAL.xlsx",
  original_name: "final_v2_REAL.xlsx",
  modified_at: "2026-10-14T09:30:00+00:00",
};
const row = {
  sha256: "b".repeat(64),
  score: 0.03,
  keyword_rank: null,
  vector_rank: 2,
  snippet: null,
  file_kind: "spreadsheet",
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: 10,
  has_preview: false,
  locations: [location, { ...location, id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0004", path: "/Old/final_v2_REAL.xlsx" }],
  label: null,
};
const label = {
  status: "check",
  clean_name: "Batch 3 gel densitometry",
  date: "2026-10-14",
  experiment: { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0010", name: "P450 BM3" },
  person: null,
  instrument: "ChemiDoc",
  tags: ["batch 3"],
  confidence: 0.62,
};

describe("search_files row parser", () => {
  it("maps ranks to match reasons and keeps every location", () => {
    const [hit] = SearchFilesRows.parse([row]);
    expect(hit?.matchedBy).toEqual(["meaning"]);
    expect(hit?.locations.map((l) => l.path)).toEqual(["/Lab/final_v2_REAL.xlsx", "/Old/final_v2_REAL.xlsx"]);
    expect(SearchFilesRows.parse([{ ...row, keyword_rank: 1 }])[0]?.matchedBy).toEqual(["words", "meaning"]);
  });

  it("rejects rows the UI could not render", () => {
    expect(SearchFilesRows.safeParse([{ ...row, locations: [] }]).success).toBe(false);
    expect(SearchFilesRows.safeParse([{ ...row, locations: null }]).success).toBe(false);
    expect(SearchFilesRows.safeParse([{ ...row, sha256: "B".repeat(64) }]).success).toBe(false);
    expect(SearchFilesRows.safeParse([{ ...row, file_kind: "hologram" }]).success).toBe(false);
    expect(SearchFilesRows.safeParse([{ ...row, keyword_rank: 0 }]).success).toBe(false);
  });
});

describe("label parser", () => {
  it("reads search_files' label column, null until the file is labeled", () => {
    expect(SearchFilesRows.parse([row])[0]?.label).toBeNull();
    const [hit] = SearchFilesRows.parse([{ ...row, label }]);
    expect(hit?.label).toEqual({
      status: "check",
      cleanName: "Batch 3 gel densitometry",
      date: "2026-10-14",
      experiment: { id: label.experiment.id, name: "P450 BM3" },
      person: null,
      instrument: "ChemiDoc",
      tags: ["batch 3"],
      confidence: 0.62,
    });
    expect(needsCheck(hit?.label ?? null)).toBe(true);
    expect(needsCheck(LabelRow.parse({ ...label, status: "suggested" }))).toBe(false);
  });

  it("holds the name exactly when the status isn't needs_look", () => {
    expect(LabelRow.parse({ ...label, status: "needs_look", clean_name: null }).cleanName).toBeNull();
    expect(LabelRow.safeParse({ ...label, status: "needs_look" }).success).toBe(false);
    expect(LabelRow.safeParse({ ...label, status: "accepted", clean_name: null }).success).toBe(false);
    expect(LabelRow.safeParse({ ...label, status: "guessed" }).success).toBe(false);
    expect(LabelRow.safeParse({ ...label, date: "Oct 14 2026" }).success).toBe(false);
  });

  it("survives the JSON trip to the browser", () => {
    const [hit] = SearchFilesRows.parse([{ ...row, label }]);
    expect(SearchResponse.parse(JSON.parse(JSON.stringify({ kind: "hybrid", results: [hit], protocols: [] })))).toEqual({
      kind: "hybrid",
      results: [hit],
      protocols: [],
    });
  });

  it("parses the queue and correction results", () => {
    const queued = { ...row, label: { ...label, status: "needs_look", clean_name: null } };
    const [file] = NeedsLookRows.parse([queued]);
    expect(file?.label.status).toBe("needs_look");
    expect(NeedsLookRows.safeParse([{ ...queued, label: null }]).success).toBe(false);
    expect(CorrectionRows.parse([{ correction_id: 7, label }]).correctionId).toBe(7);
    expect(CorrectionRows.safeParse([]).success).toBe(false);
  });
});

describe("search response parser", () => {
  const hit = SearchFilesRows.parse([row])[0];

  const protocol = {
    id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7ab001",
    kind: "tutorial",
    title: "Using the ChemiDoc",
    version: 3,
    snippet: "Open the lid and image the gel.",
  };

  it("accepts both variants after a JSON round trip", () => {
    const hybrid = JSON.parse(JSON.stringify({ kind: "hybrid", results: [hit], protocols: [protocol] }));
    expect(SearchResponse.parse(hybrid)).toEqual({ kind: "hybrid", results: [hit], protocols: [protocol] });
    const keyword = { kind: "keyword", reason: "embed_timeout", results: [], protocols: [] };
    expect(SearchResponse.parse(keyword)).toEqual(keyword);
  });

  it("rejects a keyword response without a known reason, or without protocols", () => {
    expect(SearchResponse.safeParse({ kind: "keyword", results: [], protocols: [] }).success).toBe(false);
    expect(SearchResponse.safeParse({ kind: "keyword", reason: "slow", results: [], protocols: [] }).success).toBe(false);
    expect(SearchResponse.safeParse({ kind: "vector", results: [], protocols: [] }).success).toBe(false);
    expect(SearchResponse.safeParse({ kind: "hybrid", results: [] }).success).toBe(false);
    expect(SearchResponse.safeParse({ kind: "hybrid", results: [], protocols: [{ ...protocol, kind: "recipe" }] }).success).toBe(false);
  });
});

describe("search params", () => {
  it("trims the query and drops unknown kinds", () => {
    expect(SearchParams.parse({ q: "  gels " })).toEqual({ q: "gels" });
    expect(SearchParams.safeParse({ q: "   " }).success).toBe(false);
    expect(SearchParams.safeParse({ q: "x", kind: "hologram" }).success).toBe(false);
    expect(SearchParams.safeParse({ q: "x", from: "14/10/2026" }).success).toBe(false);
  });
});

describe("other RPC parsers", () => {
  it("parses embed, progress and member rows", () => {
    expect(EmbedResponse.safeParse({ embedding: new Array(1024).fill(0) }).success).toBe(true);
    expect(EmbedResponse.safeParse({ embedding: new Array(384).fill(0) }).success).toBe(false);
    expect(
      ProgressRows.parse([{ source_id: location.source_id, pending: 3, indexed: 412, failed: 1 }])[0]?.indexed,
    ).toBe(412);
    expect(ProgressRows.safeParse([{ source_id: location.source_id, pending: -1, indexed: 0, failed: 0 }]).success).toBe(false);
    const [member] = LabMemberRows.parse([
      { user_id: location.id, email: "pi@lab.edu", role: "admin", joined_at: "2026-11-04T10:00:00+00:00" },
    ]);
    expect(member).toEqual({ userId: location.id, email: "pi@lab.edu", role: "admin", joinedAt: "2026-11-04T10:00:00+00:00" });
  });
});
