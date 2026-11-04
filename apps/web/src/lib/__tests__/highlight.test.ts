import { describe, expect, it } from "vitest";
import { excerpt, highlight, queryTerms } from "../highlight";

const marked = (text: string, query: string) =>
  highlight(text, query)
    .filter((s) => s.match)
    .map((s) => s.text);

describe("highlight", () => {
  it("marks whole words that start with a query word, ignoring case", () => {
    expect(marked("P450 gels from batch 3, gel 2", "p450 gel")).toEqual(["P450", "gels", "gel"]);
  });

  it("matches a plural query against the singular, like the stemmer", () => {
    expect(marked("one gel lane", "gels")).toEqual(["gel"]);
  });

  it("does not mark matches in the middle of a word", () => {
    expect(marked("angel", "gel")).toEqual([]);
  });

  it("keeps the full text when joined back together", () => {
    const text = "Ran the SEC column (Superdex 200) at 0.5 mL/min.";
    expect(highlight(text, "superdex min").map((s) => s.text).join("")).toBe(text);
  });

  it("treats regex-special characters in the query as separators, never as patterns", () => {
    for (const q of ["(", "a.*", "c++", "[sec]", "x|y", "\\", "$^", "?.", "{2}", "a/b"]) {
      expect(() => highlight("a.b c++ [sec] x|y $5", q)).not.toThrow();
    }
    expect(marked("Loaded [sec] column; ran.*", "[sec]")).toEqual(["sec"]);
    expect(marked("aaaa", ".*")).toEqual([]);
    expect(marked("x y xy", "x|y")).toEqual([]);
    expect(marked("IMG_4821.jpg", "IMG_4821")).toEqual(["IMG", "4821"]);
  });

  it("returns no marks for a query with no usable words", () => {
    expect(highlight("some text", "a ! ?")).toEqual([{ text: "some text", match: false }]);
    expect(highlight("", "gel")).toEqual([]);
  });

  it("handles non-ASCII letters", () => {
    expect(marked("Proteína purificada", "proteína")).toEqual(["Proteína"]);
  });
});

describe("queryTerms", () => {
  it("splits like prefix_tsquery and dedupes", () => {
    expect(queryTerms("P450 gels, P450 batch-3 a")).toEqual(["p450", "gels", "batch"]);
  });
});

describe("excerpt", () => {
  it("returns short text unchanged", () => {
    expect(excerpt("  short   text ", "x")).toBe("short text");
  });

  it("centres a long text on the first match with ellipses", () => {
    const text = `${"filler ".repeat(60)}the Superdex trace ${"tail ".repeat(60)}`;
    const out = excerpt(text, "superdex", 80);
    expect(out).toContain("Superdex");
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(82);
  });
});
