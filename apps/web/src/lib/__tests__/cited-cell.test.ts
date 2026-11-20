import { describe, expect, it } from "vitest";
import bradfordJson from "@/fixtures/tables/Bradford_2026-10-30.json";
import { citationHref } from "@/components/ask/citation-href";
import { CitedCell, findCitedCell } from "../charts";
import { DataTables } from "../data-tables";
import { LocationId, Sha256 } from "../ids";
import type { AnswerSource } from "../answers";

const tables = DataTables.parse(bradfordJson).tables;
const location = LocationId.parse("6c1c2c39-5a4e-4c55-9d7b-0c3c1a7a0042");

describe("a cell an answer cited", () => {
  it("opens the chart builder on that sheet, column and row", () => {
    const source = {
      kind: "file",
      key: "F1",
      sha256: Sha256.parse("4".repeat(64)),
      name: "Bradford_2026-10-30.xlsx",
      location: { id: location, sourceKind: "local", path: "/Bradford_2026-10-30.xlsx", originalName: "Bradford_2026-10-30.xlsx" },
    } as unknown as AnswerSource;
    const { href } = citationHref(source, { source: "F1", cell: { table: "Samples", column: "A595 (AU)", row: 3, value: "0.5" } });
    const params = new URL(href, "http://x").searchParams;
    expect(new URL(href, "http://x").pathname).toBe("/charts/new");
    expect(CitedCell.parse({ sheet: params.get("sheet"), column: params.get("column"), row: params.get("row") })).toEqual({ sheet: "Samples", column: "A595 (AU)", row: 3 });
    expect(params.get("file")).toBe(location);
  });

  it("is found by the column's name and unit, or its letter, with the row counted from 1", () => {
    const byName = findCitedCell(tables, { sheet: "Samples", column: "A595 (AU)", row: 3 });
    expect(byName?.column.id).toBe("C");
    expect(byName?.row).toBe(2);
    const value = byName?.column.kind === "number" ? byName.column.values[2] : null;
    expect(typeof value).toBe("number");
    expect(findCitedCell(tables, { sheet: "Samples", column: "C", row: 3 })?.column.name).toBe("A595");
  });

  it("isn't found once the file reads differently", () => {
    expect(findCitedCell(tables, { sheet: "Samples", column: "A600 (AU)", row: 3 })).toBeNull();
    expect(findCitedCell(tables, { sheet: "Samples", column: "A595 (AU)", row: 99 })).toBeNull();
    expect(findCitedCell(tables, { sheet: "Kinetics", column: "A595 (AU)", row: 1 })).toBeNull();
  });
});
