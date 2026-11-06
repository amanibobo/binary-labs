import { describe, expect, it } from "vitest";
import { DataTables, mainTable } from "../data-tables";
import { tableSlice } from "../table-preview";
import plateJson from "../../fixtures/tables/plate7_A420.json";

const plate = mainTable(DataTables.parse(plateJson));

describe("tableSlice", () => {
  it("shows a small corner of a kinetic read, with the Gen5 header kept as notes", () => {
    if (plate === null) throw new Error("no table");
    const short = tableSlice({ table: plate, size: "short" });
    expect(short.columns.map((c) => c.name)).toEqual(["Time", "T° Read 1:420", "A1", "A2", "A3"]);
    expect(short.rows).toBe(5);
    expect(short.cut).toBe(true);
    expect(short.size).toBe("31 rows · 98 columns");
    expect(plate.notes).toContain("Reader Serial Number: 21031514");
  });

  it("shows more after Show more, and says when even that is cut", () => {
    if (plate === null) throw new Error("no table");
    const long = tableSlice({ table: plate, size: "long" });
    expect(long.rows).toBe(30);
    expect(long.columns).toHaveLength(24);
    expect(long.cut).toBe(true);
  });

  it("isn't cut when the sheet fits", () => {
    if (plate === null) throw new Error("no table");
    const small = { ...plate, rows: 3, columns: plate.columns.slice(0, 2), rowsInFile: null, truncated: false };
    expect(tableSlice({ table: small, size: "short" })).toMatchObject({ rows: 3, cut: false, size: "3 rows · 2 columns" });
  });
});
