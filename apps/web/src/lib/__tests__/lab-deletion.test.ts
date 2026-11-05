import { describe, expect, it } from "vitest";
import { deletionFailure, exportFileName, LabDeletionRow, nameMatches, protocolsMarkdown, type ExportedPage } from "../lab-deletion";

const pages: ExportedPage[] = [
  { kind: "protocol", title: "Lysis buffer", version: 3, body: "1. Thaw on ice.\n", updatedAt: "2026-11-02T10:00:00Z" },
  { kind: "protocol", title: "SDS-PAGE", version: 1, body: "## Gel\nRun at 150 V.", updatedAt: "2026-10-30T10:00:00Z" },
  { kind: "tutorial", title: "Plate reader", version: 2, body: "Turn it on.", updatedAt: "2026-11-01T10:00:00Z" },
];

describe("the protocols download", () => {
  it("is one Markdown file with every page's title, kind, version and body, separated by rules", () => {
    expect(protocolsMarkdown({ labName: "Okafor Lab", exportedAt: new Date("2026-11-04T12:00:00Z"), pages })).toBe(
      [
        "# Okafor Lab protocols\n\nExported from Binary on Nov 4, 2026: 2 protocols and 1 tutorial, the current version of each.\n",
        "# Lysis buffer\n\nProtocol, version 3, saved Nov 2, 2026\n\n1. Thaw on ice.\n",
        "# SDS-PAGE\n\nProtocol, version 1, saved Oct 30, 2026\n\n## Gel\nRun at 150 V.\n",
        "# Plate reader\n\nTutorial, version 2, saved Nov 1, 2026\n\nTurn it on.\n",
      ].join("\n---\n\n"),
    );
  });

  it("says so when the lab has no pages", () => {
    expect(protocolsMarkdown({ labName: "Okafor Lab", exportedAt: new Date("2026-11-04T12:00:00Z"), pages: [] })).toBe(
      "# Okafor Lab protocols\n\nExported from Binary on Nov 4, 2026. The lab has no protocols or tutorials yet.\n",
    );
  });

  it("is named after the lab, safe for a Content-Disposition header", () => {
    expect(exportFileName("Okafor Lab")).toBe("okafor-lab-protocols.md");
    expect(exportFileName('Müller "Bio" Lab / 2')).toBe("muller-bio-lab-2-protocols.md");
    expect(exportFileName("实验室")).toBe("protocols.md");
  });
});

describe("confirming a deletion", () => {
  it("takes the exact name, ignoring spaces at either end like the database does", () => {
    expect(nameMatches({ typed: " Okafor Lab ", labName: "Okafor Lab" })).toBe(true);
    expect(nameMatches({ typed: "okafor lab", labName: "Okafor Lab" })).toBe(false);
    expect(nameMatches({ typed: "", labName: "Okafor Lab" })).toBe(false);
  });

  it("maps the database's codes to what the dialog says", () => {
    expect(deletionFailure({ code: "BL201" })).toEqual({ kind: "wrong_name" });
    expect(deletionFailure({ code: "42501" })).toEqual({ kind: "error", message: "Only an admin can delete the lab." });
    expect(deletionFailure({ code: "BL202" })).toEqual({ kind: "error", message: "This lab is already being deleted." });
    expect(deletionFailure({})).toEqual({ kind: "error", message: "We couldn't delete the lab. Try again." });
  });
});

describe("a lab_deletions row", () => {
  const labId = "00000000-0000-4000-8000-0000000000aa";
  it("is pending until the worker stamps it", () => {
    expect(LabDeletionRow.parse({ lab_id: labId, requested_at: "2026-11-04T21:40:00Z", completed_at: null, counts: {} })).toEqual({
      kind: "pending",
      labId,
      requestedAt: "2026-11-04T21:40:00Z",
    });
  });

  it("is done with counts once stamped, and a stamp without counts doesn't parse", () => {
    const counts = { file_locations: 40, preview_files: 12, labels: 38, protocols: 3, members: 2, chunks: 90 };
    expect(
      LabDeletionRow.parse({ lab_id: labId, requested_at: "2026-11-04T21:40:00Z", completed_at: "2026-11-04T21:41:00Z", counts }),
    ).toMatchObject({ kind: "done", removed: { files: 40, previews: 12, labels: 38, protocols: 3, members: 2 } });
    expect(
      LabDeletionRow.safeParse({ lab_id: labId, requested_at: "2026-11-04T21:40:00Z", completed_at: "2026-11-04T21:41:00Z", counts: {} })
        .success,
    ).toBe(false);
  });
});
