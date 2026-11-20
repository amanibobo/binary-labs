import { DriveFolderRows, FileHistoryRows, versionDetails, type DriveFile, type VersionDetail } from "@/lib/drive";
import { LocationId } from "@/lib/ids";
import { searchHits } from "./data";

// The lab drive as the sample lab would show it: folders by experiment, one folder's files,
// and a plate read that was edited three times.

export const driveFolders = DriveFolderRows.parse([
  { key: "", name: null, files: 7, edited: 0, changed_at: "2026-11-02T09:00:00Z" },
  { key: "5a000000-0000-4000-8000-000000000001", name: "P450 batch 3", files: 14, edited: 3, changed_at: "2026-11-05T15:12:00Z" },
  { key: "5a000000-0000-4000-8000-000000000002", name: "Bradford assay", files: 9, edited: 1, changed_at: "2026-11-04T11:40:00Z" },
  { key: "5a000000-0000-4000-8000-000000000003", name: "HeLa drug A", files: 3, edited: 0, changed_at: "2026-10-30T16:05:00Z" },
  { key: "5a000000-0000-4000-8000-000000000004", name: "Lab meetings", files: 12, edited: 0, changed_at: "2026-10-28T10:00:00Z" },
]);

export const driveMonths = DriveFolderRows.parse([
  { key: "2026-11", name: null, files: 11, edited: 3, changed_at: "2026-11-05T15:12:00Z" },
  { key: "2026-10", name: null, files: 27, edited: 1, changed_at: "2026-10-30T16:05:00Z" },
  { key: "2026-09", name: null, files: 7, edited: 0, changed_at: "2026-09-21T12:00:00Z" },
]);

const VERSION_COUNTS = [4, 1, 2, 1, 1, 1];

export const driveFiles: DriveFile[] = searchHits.slice(0, VERSION_COUNTS.length).map((hit, i) => ({ hit, versions: VERSION_COUNTS[i] ?? 1 }));

export const historyLocation = LocationId.parse("5b000000-0000-4000-8000-000000000001");

const plate = (number: number, over: Record<string, unknown>) => ({
  id: `5c000000-0000-4000-8000-00000000000${number}`,
  number,
  sha256: String(number).repeat(64),
  file_kind: "spreadsheet",
  mime: "text/csv",
  path: "/Okafor Lab/P450/batch3/plate7_kinetics.csv",
  original_name: "plate7_kinetics.csv",
  has_preview: false,
  label: {
    status: "accepted",
    clean_name: "Plate 7 kinetic read at 420 nm",
    date: "2026-11-03",
    experiment: { id: "5a000000-0000-4000-8000-000000000001", name: "P450 batch 3" },
    person: null,
    instrument: "Plate reader",
    tags: [],
    confidence: 0.95,
  },
  source_kind: "dropbox",
  who: null,
  kept: true,
  ...over,
});

const historyVersions = FileHistoryRows.parse([
  plate(1, { size: 4_120, modified_at: "2026-11-03T14:02:00Z", seen_at: "2026-11-03T14:10:00Z", original_name: "export_0031.csv", path: "/Okafor Lab/P450/batch3/export_0031.csv", kept: false }),
  plate(2, { size: 4_310, modified_at: "2026-11-03T16:45:00Z", seen_at: "2026-11-03T16:50:00Z" }),
  plate(3, { size: 4_298, modified_at: "2026-11-04T09:20:00Z", seen_at: "2026-11-04T09:30:00Z" }),
  plate(4, { size: 4_402, modified_at: "2026-11-05T15:12:00Z", seen_at: "2026-11-05T15:20:00Z" }),
]);

const HEADER = ["Plate 7, kinetic read, 420 nm", "Time (min),A1,A2,A3,B1,B2,B3"];
const READS = ["0,0.051,0.049,0.050,0.048,0.052,0.050", "5,0.112,0.109,0.115,0.090,0.094,0.091", "10,0.181,0.176,0.185,0.139,0.142,0.140", "15,0.246,0.240,0.251,0.186,0.190,0.188"];

const historyTexts = [
  [...HEADER, ...READS].join("\n"),
  [...HEADER, "Blank,0.050,0.050,0.050,0.050,0.050,0.050", ...READS].join("\n"),
  [...HEADER, "Blank,0.050,0.050,0.050,0.050,0.050,0.050", ...READS.slice(0, 3), "15,0.246,0.240,0.251,0.186,0.190,0.199"].join("\n"),
  [
    ...HEADER,
    "Blank,0.050,0.050,0.050,0.050,0.050,0.050",
    ...READS.slice(0, 3),
    "15,0.246,0.240,0.251,0.186,0.190,0.199",
    "20,0.305,0.298,0.311,0.229,0.233,0.240",
    "Note: B3 drifted after 15 min; repeat this well.",
  ].join("\n"),
];

export const historyDetails: VersionDetail[] = versionDetails(historyVersions, historyTexts);
