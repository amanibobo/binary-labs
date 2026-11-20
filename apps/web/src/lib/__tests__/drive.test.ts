import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  changeLine,
  driveFolderHref,
  driveFolderMeta,
  driveFolderName,
  DriveFolderRows,
  driveKeyFromSegment,
  fileHistoryHref,
  FileHistoryRows,
  parseDriveFiles,
  sortDriveFolders,
  versionDetails,
  versionFileHref,
  versionSource,
  type FileVersion,
} from "../drive";
import { LocationId, Sha256 } from "../ids";
import { diffCounts, diffLines, diffRows } from "../text-diff";
import { bytesMatch } from "../version-open";

const location = LocationId.parse("11111111-1111-4111-8111-111111111111");
const experiment = "22222222-2222-4222-8222-222222222222";

function version(number: number, over: Partial<Record<string, unknown>> = {}): FileVersion {
  const [row] = FileHistoryRows.parse([
    {
      id: `33333333-3333-4333-8333-00000000000${number}`,
      number,
      sha256: String(number).repeat(64),
      file_kind: "spreadsheet",
      mime: "text/csv",
      size: 1000 * number,
      path: "/Lab/P450/plate.csv",
      original_name: "plate.csv",
      modified_at: `2026-11-0${number}T10:00:00Z`,
      seen_at: `2026-11-0${number}T10:05:00Z`,
      has_preview: false,
      label: null,
      source_kind: "dropbox",
      who: null,
      kept: true,
      ...over,
    },
  ]);
  if (row === undefined) throw new Error("no row");
  return row;
}

describe("line changes between two versions", () => {
  it("finds what was added and removed and keeps the rest in order", () => {
    const lines = diffLines("Well,OD\nA1,0.40\nA2,0.41\nA3,0.39\n", "Well,OD\nA1,0.40\nA2,0.55\nA3,0.39\nA4,0.38\n");
    expect(lines).toEqual([
      { kind: "same", text: "Well,OD" },
      { kind: "same", text: "A1,0.40" },
      { kind: "removed", text: "A2,0.41" },
      { kind: "added", text: "A2,0.55" },
      { kind: "same", text: "A3,0.39" },
      { kind: "added", text: "A4,0.38" },
    ]);
    expect(diffCounts(lines ?? [])).toEqual({ added: 2, removed: 1 });
  });

  it("says nothing changed for the same text, whatever its line endings", () => {
    expect(diffCounts(diffLines("a\r\nb\r\n", "a\nb") ?? [])).toEqual({ added: 0, removed: 0 });
  });

  it("gives up lining up a change too long to hold, and still handles a long file with a small change", () => {
    const long = (tag: string) => Array.from({ length: 2000 }, (_, i) => `${tag} ${i}`).join("\n");
    expect(diffLines(long("before"), long("after"))).toBeNull();
    const base = long("row");
    const edited = diffLines(base, base.replace("row 1000", "row one thousand"));
    expect(diffCounts(edited ?? [])).toEqual({ added: 1, removed: 1 });
  });

  it("folds the unchanged lines away from a change into gaps", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const after = before.map((l) => (l === "line 10" ? "line ten" : l));
    const rows = diffRows(diffLines(before.join("\n"), after.join("\n")) ?? [], 1);
    expect(rows).toEqual([
      { kind: "gap", count: 9 },
      { kind: "same", text: "line 9" },
      { kind: "removed", text: "line 10" },
      { kind: "added", text: "line ten" },
      { kind: "same", text: "line 11" },
      { kind: "gap", count: 8 },
    ]);
  });
});

describe("the drive's folders", () => {
  const folders = DriveFolderRows.parse([
    { key: "", name: null, files: 4, edited: 0, changed_at: "2026-11-01T00:00:00Z" },
    { key: experiment, name: "P450 batch 3", files: "12", edited: 3, changed_at: "2026-11-03T00:00:00Z" },
    { key: "33333333-3333-4333-8333-333333333333", name: "Bradford", files: 1, edited: 0, changed_at: "2026-11-02T00:00:00Z" },
  ]);

  it("names them, puts the unsorted one last and says how many files have older versions", () => {
    const sorted = sortDriveFolders("experiment", folders);
    expect(sorted.map((f) => driveFolderName("experiment", f))).toEqual(["Bradford", "P450 batch 3", "No experiment yet"]);
    expect(sorted.map(driveFolderMeta)).toEqual(["1 file", "12 files · 3 with older versions", "4 files"]);
  });

  it("names months and lists the newest first", () => {
    const months = DriveFolderRows.parse(
      ["2026-09", "2026-11", "2025-12"].map((key) => ({ key, name: null, files: 1, edited: 0, changed_at: "2026-11-01T00:00:00Z" })),
    );
    expect(sortDriveFolders("month", months).map((f) => driveFolderName("month", f))).toEqual([
      "November 2026",
      "September 2026",
      "December 2025",
    ]);
  });

  it("round-trips a folder's key through its address and refuses anything else", () => {
    for (const folder of folders) {
      const segment = driveFolderHref("experiment", folder.key).split("/").at(-1) ?? "";
      expect(driveKeyFromSegment(segment)).toBe(folder.key);
    }
    expect(driveFolderHref("person", folders[0]?.key ?? driveKeyFromSegment("none")!, 100)).toBe("/drive/person/none?from=100");
    expect(driveKeyFromSegment("2026-13")).toBeNull();
    expect(driveKeyFromSegment("../etc")).toBeNull();
  });
});

describe("a drive file row", () => {
  it("keeps the version count beside the file, and refuses a row without one", () => {
    const row = {
      sha256: "a".repeat(64),
      file_kind: "pdf",
      mime: "application/pdf",
      size: 10,
      has_preview: true,
      snippet: null,
      locations: [{ id: location, source_id: experiment, source_kind: "dropbox", path: "/Lab/a.pdf", original_name: "a.pdf", modified_at: "2026-11-01T00:00:00Z" }],
      label: null,
      versions: 4,
    };
    const [file] = parseDriveFiles([row]);
    expect(file?.versions).toBe(4);
    expect(file?.hit.locations[0].id).toBe(location);
    expect(() => parseDriveFiles([{ ...row, versions: 0 }])).toThrow();
  });
});

describe("a file's versions", () => {
  it("says what each one changed from the one before", () => {
    const versions = [
      version(1),
      version(2, { original_name: "plate_final.csv", path: "/Lab/P450/plate_final.csv" }),
      version(3, { original_name: "plate_final.csv", path: "/Lab/Archive/plate_final.csv", size: 1500 }),
    ];
    const details = versionDetails(versions, ["Well,OD\nA1,0.40", "Well,OD\nA1,0.40\nA2,0.41", "Well,OD\nA2,0.41"]);
    expect(details.map((d) => changeLine(d.change))).toEqual([
      "The first version Binary read",
      "1 line added · renamed from plate.csv",
      "1 line removed · moved from /Lab/P450",
    ]);
    expect(details[0]?.lines?.map((l) => l.kind)).toEqual(["added", "added"]);
  });

  it("falls back to the size when there's no text to compare", () => {
    const details = versionDetails([version(1, { file_kind: "image" }), version(2, { file_kind: "image" })], [null, null]);
    expect(details.map((d) => d.lines)).toEqual([null, null]);
    expect(changeLine(details[1]!.change)).toBe("Changed, 1 KB larger");
    const oneSided = versionDetails([version(1), version(2)], [null, "now it has text"]);
    expect(oneSided[1]?.lines).toBeNull();
  });

  it("names who a version came from only where the source says", () => {
    expect(versionSource(version(1))).toBeNull();
    expect(versionSource(version(1, { source_kind: "instrument", who: "Plate reader 214" }))).toBe("sent by Plate reader 214");
    expect(versionSource(version(1, { source_kind: "upload", who: "Maya Okafor" }))).toBe("uploaded by Maya Okafor");
  });

  it("opens a kept version from our store and offers nothing for one that wasn't kept", () => {
    const kept = version(2);
    expect(versionFileHref(kept)).toBe(`/api/drive/versions/${kept.id}`);
    expect(versionFileHref(version(1, { kept: false }))).toBeNull();
    expect(fileHistoryHref(location)).toBe(`/drive/file/${location}`);
    expect(fileHistoryHref(location, 2)).toBe(`/drive/file/${location}?v=2`);
  });
});

describe("checking a kept version before it opens", () => {
  async function* chunks(...parts: string[]) {
    for (const part of parts) yield new TextEncoder().encode(part);
  }
  const sha = Sha256.parse(createHash("sha256").update("pellet thawed on ice").digest("hex"));

  it("passes the bytes that were read and refuses anything else", async () => {
    expect(await bytesMatch(chunks("pellet thawed", " on ice"), sha)).toBe(true);
    expect(await bytesMatch(chunks("pellet thawed on ice."), sha)).toBe(false);
    expect(await bytesMatch(chunks(), sha)).toBe(false);
  });
});
