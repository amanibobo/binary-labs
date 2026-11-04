import { describe, expect, it } from "vitest";
import { FolderPath } from "../folders";
import { folderTint, TINTS, tintFor } from "../tints";

const path = (p: string) => FolderPath.parse(p);

describe("folder tints", () => {
  it("gives a top-level folder the same tint every time, ignoring case", () => {
    expect(tintFor("P450")).toBe(tintFor("p450"));
    expect(folderTint(path("P450"))).toEqual({ tint: tintFor("P450"), shade: "base" });
  });

  it("gives every subfolder its top-level folder's tint in the soft shade", () => {
    const top = folderTint(path("Crystallography")).tint;
    expect(folderTint(path("Crystallography/Screens"))).toEqual({ tint: top, shade: "soft" });
    expect(folderTint(path("Crystallography/Screens/plate 7"))).toEqual({ tint: top, shade: "soft" });
  });

  it("spreads names across the whole palette", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => tintFor(`folder ${i}`)));
    expect([...seen].sort()).toEqual([...TINTS].sort());
  });
});
