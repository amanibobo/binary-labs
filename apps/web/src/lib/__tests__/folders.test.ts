import { describe, expect, it } from "vitest";
import {
  buildFolderTree,
  folderAncestors,
  folderHref,
  folderName,
  FolderPath,
  folderPathFromSegments,
  FolderTreeRows,
  ROOT_FOLDER,
  topLevelOf,
  type FolderNode,
} from "../folders";

const p = (s: string) => FolderPath.parse(s);

const outline = (node: FolderNode): unknown => [
  node.path,
  node.name,
  node.depth,
  node.directFiles,
  node.totalFiles,
  node.children.map(outline),
];

describe("FolderPath", () => {
  it("accepts the root and slash-separated segments", () => {
    for (const ok of ["", "P450", "P450/batch3", "a b/c.d"]) expect(FolderPath.safeParse(ok).success).toBe(true);
  });

  it("rejects leading, trailing and doubled slashes", () => {
    for (const bad of ["/", "/P450", "P450/", "P450//batch3"]) expect(FolderPath.safeParse(bad).success).toBe(false);
  });
});

describe("FolderTreeRows", () => {
  it("parses bigint counts sent as numbers or numeric strings", () => {
    const rows = FolderTreeRows.parse([
      { path: "", parent: null, direct_files: 1, total_files: "3" },
      { path: "P450", parent: "", direct_files: "2", total_files: 2 },
    ]);
    expect(rows).toEqual([
      { path: "", parent: null, directFiles: 1, totalFiles: 3 },
      { path: "P450", parent: "", directFiles: 2, totalFiles: 2 },
    ]);
  });

  it("rejects negative or fractional counts and a parent that is not the path's parent", () => {
    expect(FolderTreeRows.safeParse([{ path: "", parent: null, direct_files: -1, total_files: 0 }]).success).toBe(false);
    expect(FolderTreeRows.safeParse([{ path: "", parent: null, direct_files: "1.5", total_files: 0 }]).success).toBe(false);
    expect(FolderTreeRows.safeParse([{ path: "a/b", parent: "", direct_files: 0, total_files: 0 }]).success).toBe(false);
    expect(FolderTreeRows.safeParse([{ path: "a", parent: null, direct_files: 0, total_files: 0 }]).success).toBe(false);
  });
});

describe("buildFolderTree", () => {
  it("has an empty root when there are no rows", () => {
    const tree = buildFolderTree([]);
    expect(outline(tree.root)).toEqual(["", "", 0, 0, 0, []]);
    expect([...tree.byPath.keys()]).toEqual([""]);
  });

  it("nests folders under their parents with depth, name and counts, whatever the row order", () => {
    const rows = FolderTreeRows.parse([
      { path: "P450/batch3", parent: "P450", direct_files: 2, total_files: 2 },
      { path: "", parent: null, direct_files: 1, total_files: 5 },
      { path: "P450", parent: "", direct_files: 1, total_files: 3 },
      { path: "Gels", parent: "", direct_files: 1, total_files: 1 },
    ]);
    const tree = buildFolderTree(rows);
    expect(outline(tree.root)).toEqual([
      "",
      "",
      0,
      1,
      5,
      [
        ["Gels", "Gels", 1, 1, 1, []],
        ["P450", "P450", 1, 1, 3, [["P450/batch3", "batch3", 2, 2, 2, []]]],
      ],
    ]);
    expect(tree.byPath.get(p("P450/batch3"))?.name).toBe("batch3");
    expect(tree.byPath.size).toBe(4);
  });

  it("sorts children by name, numerically and ignoring case", () => {
    const rows = ["plate10", "Plate2", "alpha", "plate1"].map((name) => ({
      path: p(name),
      parent: ROOT_FOLDER,
      directFiles: 1,
      totalFiles: 1,
    }));
    expect(buildFolderTree(rows).root.children.map((c) => c.name)).toEqual(["alpha", "plate1", "Plate2", "plate10"]);
  });

  it("creates missing ancestors with zero counts", () => {
    const tree = buildFolderTree([{ path: p("a/b"), parent: p("a"), directFiles: 4, totalFiles: 4 }]);
    expect(outline(tree.root)).toEqual(["", "", 0, 0, 0, [["a", "a", 1, 0, 0, [["a/b", "b", 2, 4, 4, []]]]]]);
  });
});

describe("path helpers", () => {
  it("reads Next catch-all segments", () => {
    expect(folderPathFromSegments(undefined)).toBe("");
    expect(folderPathFromSegments(["P450"])).toBe("P450");
    expect(folderPathFromSegments(["P450", "batch%203"])).toBe("P450/batch 3");
    expect(folderPathFromSegments(["P450", ""])).toBeNull();
    expect(folderPathFromSegments(["P450%2Fbatch3"])).toBeNull();
    expect(folderPathFromSegments(["50%"])).toBeNull();
  });

  it("builds hrefs that round-trip through the encoded segments Next passes", () => {
    expect(folderHref(ROOT_FOLDER)).toBe("/browse");
    expect(folderHref(p("P450/batch 3#1"))).toBe("/browse/P450/batch%203%231");
    const href = folderHref(p("Gels & Blots/50% run"));
    const segments = href.replace(/^\/browse\//, "").split("/");
    expect(folderPathFromSegments(segments)).toBe("Gels & Blots/50% run");
  });

  it("lists ancestors from the root down to the folder", () => {
    expect(folderAncestors(ROOT_FOLDER)).toEqual([""]);
    expect(folderAncestors(p("P450/batch3/raw"))).toEqual(["", "P450", "P450/batch3", "P450/batch3/raw"]);
  });

  it("names the last segment and finds the top-level folder", () => {
    expect(folderName(ROOT_FOLDER)).toBe("");
    expect(folderName(p("P450/batch3"))).toBe("batch3");
    expect(topLevelOf(ROOT_FOLDER)).toBeNull();
    expect(topLevelOf(p("P450"))).toBe("P450");
    expect(topLevelOf(p("P450/batch3/raw"))).toBe("P450");
  });
});
