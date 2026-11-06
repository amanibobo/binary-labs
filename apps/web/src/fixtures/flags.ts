import { CheckSpecs, type CheckSpec } from "@/lib/checks";
import { DataTables, type TableState } from "@/lib/data-tables";
import { FileLocation } from "@/lib/domain";
import { FlagRows, usefulnessKey, type FileChecks, type Flag, type UsefulnessByCheck } from "@/lib/flags";
import { CheckId, ProtocolId, Sha256 } from "@/lib/ids";
import { ProtocolVersionWire } from "@/lib/protocols";
import { BRADFORD } from "./charts";
import bradford1104Json from "./tables/Bradford_2026-11-04.json";
import plate8Json from "./tables/plate8_A595_endpoint.json";

// Dev-only flags: a Bradford protocol with checks, the worker's own parse of the check fixtures
// (workers/scripts/make_table_fixtures.py), and the flags it would raise on them.

export const PLATE8 = Sha256.parse("5".repeat(64));
export const BRADFORD_1104 = Sha256.parse("6".repeat(64));

const TABLES = new Map<Sha256, DataTables>([
  [PLATE8, DataTables.parse(plate8Json)],
  [BRADFORD_1104, DataTables.parse(bradford1104Json)],
]);

export function flagTable(sha: Sha256): TableState | null {
  const tables = TABLES.get(sha);
  return tables === undefined ? null : { state: "ready", tables };
}

const PROTOCOL = ProtocolId.parse("7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0042");
const versionId = (n: number) => `7b1c2c39-5a4e-4c55-9d7b-0c3c1a7b00${String(n).padStart(2, "0")}`;
const priya = "00000000-0000-4000-8000-00000000000b";

export const bradfordAssay = ProtocolVersionWire.parse({
  protocolId: PROTOCOL,
  kind: "protocol",
  archived: false,
  currentVersionId: versionId(3),
  currentVersion: 3,
  id: versionId(3),
  version: 3,
  title: "Bradford assay",
  body: "1. Make the BSA standards from 0 to 1000 µg/mL in PBS.\n2. Add 250 µL reagent to 5 µL of each standard and sample, in triplicate.\n3. Read at 595 nm after 10 min. Leave three wells as blanks.",
  note: null,
  author: priya,
  createdAt: "2026-11-02T10:00:00Z",
});

export const CURVE = CheckId.parse("0f8f2c1e-0001-4a4e-8c55-0c3c1a7a0001");
export const BLANKS = CheckId.parse("0f8f2c1e-0002-4a4e-8c55-0c3c1a7a0002");
const SAMPLES = CheckId.parse("0f8f2c1e-0003-4a4e-8c55-0c3c1a7a0003");

export const bradfordChecks: CheckSpec[] = CheckSpecs.parse([
  { id: CURVE, name: "Standard curve fit", kind: "curve_fit", sheet: null, unit: null, range: { kind: "at_least", min: 0.98 }, x: null, y: null },
  {
    id: BLANKS,
    name: "Blanks",
    kind: "control",
    sheet: null,
    unit: "AU",
    range: { kind: "at_most", max: 0.1 },
    pattern: "blank",
    labelColumn: null,
    column: "A595",
    use: "each",
  },
  {
    id: SAMPLES,
    name: "Samples in the curve's range",
    kind: "value",
    sheet: "Samples",
    unit: "AU",
    range: { kind: "between", min: 0.43, max: 1.04 },
    column: "A595",
    stat: "max",
    row: null,
  },
]);

export const bradfordUsefulness: UsefulnessByCheck = {
  [usefulnessKey(PROTOCOL, CURVE)]: { flags: 6, useful: 4, wrong: 0, knownIssue: 1 },
  [usefulnessKey(PROTOCOL, BLANKS)]: { flags: 3, useful: 1, wrong: 1, knownIssue: 0 },
};

const source = "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001";
const location = (id: number, path: string, modified: string) =>
  FileLocation.parse({
    id: `6f1c2c39-5a4e-4c55-9d7b-0c3c1a7f${String(id).padStart(4, "0")}`,
    source_id: source,
    source_kind: "dropbox",
    path,
    original_name: path.slice(path.lastIndexOf("/") + 1),
    modified_at: modified,
  });
const ref = (loc: FileLocation, cleanName: string | null) => ({ location: loc, cleanName });

const row = (r: Record<string, unknown>) => ({
  protocol_id: PROTOCOL,
  protocol_title: "Bradford assay",
  protocol_version: 3,
  protocol_version_id: versionId(3),
  unit: null,
  control_sha256: null,
  control_sheet: null,
  control_columns: null,
  control_rows: null,
  cleared_at: null,
  cleared_reason: null,
  review: null,
  review_note: null,
  reviewed_by: null,
  reviewed_at: null,
  control_file: null,
  ...r,
});

const oct30 = ref(location(1, "/Lab/Data/Bradford/Bradford_2026-10-30.xlsx", "2026-10-30T15:10:00Z"), "Bradford assay, Oct 30");
const plate8 = ref(location(2, "/Lab/Instruments/Plate reader/plate8_A595_endpoint.csv", "2026-11-04T16:20:00Z"), "Plate 8, A595 endpoint");
const nov4 = ref(location(3, "/Lab/Data/Bradford/Bradford_2026-11-04.xlsx", "2026-11-04T11:02:00Z"), "Bradford assay, Nov 4");

export const fixtureFlags: Flag[] = FlagRows.parse([
  row({
    id: "9f1c2c39-5a4e-4c55-9d7b-0c3c1a7f0001",
    sha256: BRADFORD,
    check_id: CURVE,
    check_name: "Standard curve fit",
    kind: "curve_fit",
    observed: 0.9418,
    expected: { kind: "at_least", min: 0.98 },
    source_sheet: "Standards",
    source_columns: ["A", "E"],
    source_rows: [[0, 7]],
    raised_at: "2026-11-04T09:12:00Z",
    file: oct30,
  }),
  row({
    id: "9f1c2c39-5a4e-4c55-9d7b-0c3c1a7f0002",
    sha256: PLATE8,
    check_id: BLANKS,
    check_name: "Blanks",
    kind: "control",
    observed: 0.225,
    expected: { kind: "at_most", max: 0.1 },
    unit: "AU",
    source_sheet: "Table 1",
    source_columns: ["C"],
    source_rows: [[3, 14]],
    control_sha256: PLATE8,
    control_sheet: "Table 1",
    control_columns: ["B", "C"],
    control_rows: [[0, 2]],
    raised_at: "2026-11-04T16:21:00Z",
    file: plate8,
    control_file: plate8,
  }),
  row({
    id: "9f1c2c39-5a4e-4c55-9d7b-0c3c1a7f0003",
    sha256: BRADFORD_1104,
    check_id: CURVE,
    check_name: "Standard curve fit",
    kind: "curve_fit",
    observed: 0.8762,
    expected: { kind: "at_least", min: 0.98 },
    source_sheet: "Standards",
    source_columns: ["A", "E"],
    source_rows: [[0, 5]],
    raised_at: "2026-11-04T11:03:00Z",
    review: "useful",
    review_note: "The 750 standard was pipetted short. Rerunning Friday.",
    reviewed_by: priya,
    reviewed_at: "2026-11-04T13:40:00Z",
    file: nov4,
  }),
]);

export function flagById(id: string): Flag {
  const flag = fixtureFlags.find((f) => f.id === id) ?? fixtureFlags[0];
  if (flag === undefined) throw new Error("no fixture flags");
  return flag;
}

const flagOf = (sha: Sha256) => fixtureFlags.filter((f) => f.source.sha256 === sha);
const blanksMissing = "No rows named like “blank” in this file or in another file from the same experiment and day.";
const common = { protocolId: PROTOCOL, protocolTitle: "Bradford assay", protocolVersion: 3 };

export function fixtureFileChecks(sha: Sha256): FileChecks {
  const flags = flagOf(sha);
  if (sha === BRADFORD || sha === BRADFORD_1104) {
    return {
      checking: false,
      flags,
      checks: [
        { ...common, checkId: CURVE, checkName: "Standard curve fit", kind: "curve_fit", expected: { kind: "at_least", min: 0.98 }, unit: null, outcome: { kind: "flagged", observed: flags[0]?.observed ?? 0, flagId: flags[0]?.id ?? null } },
        { ...common, checkId: BLANKS, checkName: "Blanks", kind: "control", expected: { kind: "at_most", max: 0.1 }, unit: "AU", outcome: { kind: "couldnt", reason: blanksMissing } },
        { ...common, checkId: SAMPLES, checkName: "Samples in the curve's range", kind: "value", expected: { kind: "between", min: 0.43, max: 1.04 }, unit: "AU", outcome: { kind: "passed", observed: 1.021 } },
      ],
    };
  }
  if (sha === PLATE8) {
    return {
      checking: false,
      flags,
      checks: [
        { ...common, checkId: CURVE, checkName: "Standard curve fit", kind: "curve_fit", expected: { kind: "at_least", min: 0.98 }, unit: null, outcome: { kind: "couldnt", reason: "Couldn't tell which columns are the concentration and the signal. Name them in the check." } },
        { ...common, checkId: BLANKS, checkName: "Blanks", kind: "control", expected: { kind: "at_most", max: 0.1 }, unit: "AU", outcome: { kind: "flagged", observed: 0.225, flagId: flags[0]?.id ?? null } },
      ],
    };
  }
  return { checking: false, flags: [], checks: [] };
}

export function fixtureFlagMarks(shas: readonly Sha256[]): Record<string, number> {
  return Object.fromEntries(shas.flatMap((sha) => {
    const open = flagOf(sha).filter((f) => f.answer?.review !== "wrong").length;
    return open === 0 ? [] : [[sha, open]];
  }));
}
