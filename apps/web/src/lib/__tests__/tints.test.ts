import { describe, expect, it } from "vitest";
import { buildFolderTree, FolderPath, type FolderRow } from "../folders";
import { FOLDER_TINTS, TINTS, tintFor } from "../tints";

const path = (p: string) => FolderPath.parse(p);
const row = (p: string, parent: string | null): FolderRow => ({
  path: path(p),
  parent: parent === null ? null : path(parent),
  directFiles: 1,
  totalFiles: 1,
});

const tree = buildFolderTree([
  row("", null),
  row("Shared", ""),
  row("P450", ""),
  row("protocols", ""),
  row("People", ""),
  row("Crystallography", ""),
  row("Thermal shift", ""),
  row("Crystallography/Screens", "Crystallography"),
  row("Crystallography/Screens/plate 7", "Crystallography/Screens"),
]);
const tintOf = (p: string) => tree.byPath.get(path(p))?.tint;

describe("folder tints", () => {
  it("gives six top-level folders six different tints, in name order", () => {
    const tops = tree.root.children.map((n) => [n.name, n.tint.tint]);
    expect(tops).toEqual([
      ["Crystallography", FOLDER_TINTS[0]],
      ["P450", FOLDER_TINTS[1]],
      ["People", FOLDER_TINTS[2]],
      ["protocols", FOLDER_TINTS[3]],
      ["Shared", FOLDER_TINTS[4]],
      ["Thermal shift", FOLDER_TINTS[5]],
    ]);
    expect(new Set(tops.map(([, t]) => t)).size).toBe(6);
  });

  it("gives every subfolder its top-level folder's tint in the soft shade", () => {
    expect(tintOf("Crystallography")).toEqual({ tint: FOLDER_TINTS[0], shade: "base" });
    expect(tintOf("Crystallography/Screens")).toEqual({ tint: FOLDER_TINTS[0], shade: "soft" });
    expect(tintOf("Crystallography/Screens/plate 7")).toEqual({ tint: FOLDER_TINTS[0], shade: "soft" });
  });

  it("keeps avatar tints stable by key and spread across the palette", () => {
    expect(tintFor("Priya@lab.edu")).toBe(tintFor("priya@lab.edu"));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => tintFor(`person ${i}`)));
    expect([...seen].sort()).toEqual([...TINTS].sort());
  });
});
