import { describe, expect, it } from "vitest";
import {
  CreateProtocolRequest,
  plainText,
  protocolFailure,
  ProtocolVersionRows,
  SaveOutcomeWire,
  SaveProtocolRequest,
  SearchProtocolsRows,
  titleFromFile,
} from "../protocols";

const versionRow = {
  protocol_id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001",
  kind: "protocol",
  archived_at: null,
  current_version_id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7b0002",
  current_version: 2,
  version_id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7b0001",
  version: 1,
  title: "Lysis",
  body: "1. Thaw.",
  note: null,
  author: null,
  created_at: "2026-11-04T10:00:00+00:00",
};

describe("protocol rows", () => {
  it("reads one version, or null when the page isn't there", () => {
    const page = ProtocolVersionRows.parse([versionRow]);
    expect(page).toMatchObject({ version: 1, currentVersion: 2, archived: false, author: null });
    expect(page?.id).not.toBe(page?.currentVersionId);
    expect(ProtocolVersionRows.parse([])).toBeNull();
    expect(ProtocolVersionRows.safeParse([versionRow, versionRow]).success).toBe(false);
    expect(ProtocolVersionRows.safeParse([{ ...versionRow, kind: "recipe" }]).success).toBe(false);
  });

  it("turns search snippets into plain words", () => {
    const [hit] = SearchProtocolsRows.parse([
      { id: versionRow.protocol_id, kind: "tutorial", title: "ChemiDoc", version: 1, snippet: "## Exposure\nUse **auto** first." },
      { id: versionRow.protocol_id, kind: "protocol", title: "Empty", version: 1, snippet: null },
    ]);
    expect(hit?.snippet).toBe("Exposure: Use auto first.");
  });
});

describe("plainText", () => {
  it("keeps the words of steps, links, tables and quotes", () => {
    expect(plainText("1. Spin at [15,000 g](https://x.test).\n2. Keep the `supernatant`.")).toBe(
      "Spin at 15,000 g. Keep the supernatant .",
    );
    expect(plainText("| Buffer | NaCl |\n| --- | :---: |\n| Lysis | 300 mM |")).toBe("Buffer NaCl Lysis 300 mM");
    expect(plainText("> Keep the gel photo\n\n---\n\n- one\n* two")).toBe("Keep the gel photo one two");
    expect(plainText("![gel](https://x.test/g.png)")).toBe("gel");
  });
});

describe("requests", () => {
  it("trims titles and notes, and an empty note is no note", () => {
    const req = SaveProtocolRequest.parse({
      baseVersionId: versionRow.version_id,
      title: "  Lysis  ",
      body: "x",
      note: "   ",
    });
    expect(req).toMatchObject({ title: "Lysis", note: null });
  });

  it("names what's wrong with a bad page", () => {
    const blank = CreateProtocolRequest.safeParse({ kind: "protocol", title: " ", body: "", note: null, fromSha256: null });
    expect(blank.success ? null : blank.error.issues[0]?.message).toBe("Give the page a title.");
    const long = CreateProtocolRequest.safeParse({ kind: "protocol", title: "x".repeat(201), body: "", note: null, fromSha256: null });
    expect(long.success).toBe(false);
    expect(CreateProtocolRequest.safeParse({ kind: "protocol", title: "x", body: "", note: null, fromSha256: "abc" }).success).toBe(false);
  });

  it("tells a stale save apart from other failures", () => {
    expect(protocolFailure({ code: "BL101", message: "" })).toEqual({ kind: "stale" });
    expect(protocolFailure({ code: "BL102", message: "" })).toMatchObject({ kind: "error", status: 409 });
    expect(protocolFailure({ code: "BL103", message: "" })).toMatchObject({ kind: "error", status: 404 });
    expect(protocolFailure({ code: "XX000", message: "" })).toMatchObject({ kind: "error", status: 500 });
    expect(SaveOutcomeWire.parse({ kind: "stale", error: "Someone saved a newer version." })).toEqual({ kind: "stale" });
  });
});

describe("titleFromFile", () => {
  it("prefers the clean name, then the file name without its extension", () => {
    expect(titleFromFile({ cleanName: "BM3 purification, v3", originalName: "p450_v3.pdf" })).toBe("BM3 purification, v3");
    expect(titleFromFile({ cleanName: null, originalName: "lysis_buffer_recipe.docx" })).toBe("lysis buffer recipe");
    expect(titleFromFile({ cleanName: null, originalName: ".notes" })).toBe(".notes");
  });
});
