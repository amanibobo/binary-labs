import { FolderFilesRows } from "@/lib/folders";
import {
  HistoryRows,
  ProtocolListRows,
  ProtocolVersionRows,
  SearchProtocolsRows,
  type AuthorNames,
  type ProtocolVersion,
} from "@/lib/protocols";
import { members, searchHits } from "./data";

// Dev-only screenshot data for the protocol pages, parsed through the same row schemas as
// the database's answers. Imported only from *.dev.tsx pages and the fixture API.

const ade = "00000000-0000-4000-8000-00000000000a";
const priya = "00000000-0000-4000-8000-00000000000b";
const jordan = "00000000-0000-4000-8000-00000000000c";

export const authors: AuthorNames = Object.fromEntries(members.flatMap((m) => (m.email === null ? [] : [[m.userId, m.email]])));

const purificationId = "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001";
const id = (n: number) => `7a1c2c39-5a4e-4c55-9d7b-0c3c1a7b${String(n).padStart(4, "0")}`;

export const purificationBody = `Run this for every BM3 batch. Plan on two days: expression and lysis on day one, the nickel column and the gel on day two.

## Before you start

- Thaw one 50 mL pellet on ice for 20 min.
- Make 200 mL lysis buffer fresh and keep it at 4 °C.

| Buffer | Tris-HCl pH 8.0 | NaCl | Imidazole |
| --- | --- | --- | --- |
| Lysis | 50 mM | 300 mM | 10 mM |
| Wash | 50 mM | 300 mM | 25 mM |
| Elution | 50 mM | 300 mM | 250 mM |

## Steps

1. Resuspend the pellet in 40 mL lysis buffer with one protease inhibitor tablet.
2. Sonicate on ice, 10 s on and 20 s off, for 5 min total at 40% amplitude.
3. Spin the lysate at 15,000 g for 30 min at 4 °C. Keep the supernatant.
4. Load the supernatant on a 5 mL HisTrap column at 1 mL/min.
5. Wash with 10 column volumes of wash buffer, then elute in 1 mL fractions.
6. Run fractions on an SDS-PAGE gel next to the ladder. BM3 runs near 119 kDa.

> Keep the gel photo with the batch number in the file name, so search finds it next to the batch's yields.

## What a good run looks like

The A418/A280 ratio of the pooled fractions is above 0.4, and the gel shows one strong band near 119 kDa.
`;

const versionRow = (r: {
  version: number;
  title: string;
  body: string;
  note: string | null;
  author: string;
  created: string;
  current?: number;
}) => ({
  protocol_id: purificationId,
  kind: "protocol",
  archived_at: null,
  current_version_id: id(r.current ?? 4),
  current_version: r.current ?? 4,
  version_id: id(r.version),
  version: r.version,
  title: r.title,
  body: r.body,
  note: r.note,
  author: r.author,
  created_at: r.created,
});

const parseVersion = (row: ReturnType<typeof versionRow>): ProtocolVersion => {
  const parsed = ProtocolVersionRows.parse([row]);
  if (parsed === null) throw new Error("fixture version did not parse");
  return parsed;
};

export const purification = parseVersion(
  versionRow({
    version: 4,
    title: "P450 BM3 purification",
    body: purificationBody,
    note: "Longer spin after lysis",
    author: priya,
    created: "2026-11-02T15:20:00Z",
  }),
);

export const purificationV2 = parseVersion(
  versionRow({
    version: 2,
    title: "P450 purification",
    body: purificationBody.replace("15,000 g for 30 min", "12,000 g for 20 min"),
    note: "Added the buffer table",
    author: ade,
    created: "2026-10-12T10:00:00Z",
  }),
);

// What another member saved while the edit fixture was open.
export const purificationTheirs = parseVersion(
  versionRow({
    version: 5,
    current: 5,
    title: "P450 BM3 purification",
    body: purificationBody.replace("for 5 min total", "for 6 min total"),
    note: "Sonicate a minute longer",
    author: jordan,
    created: "2026-11-04T11:42:00Z",
  }),
);

export const history = HistoryRows.parse([
  { id: id(4), version: 4, title: "P450 BM3 purification", note: "Longer spin after lysis", author: priya, created_at: "2026-11-02T15:20:00Z" },
  { id: id(3), version: 3, title: "P450 BM3 purification", note: null, author: jordan, created_at: "2026-10-21T09:12:00Z" },
  { id: id(2), version: 2, title: "P450 purification", note: "Added the buffer table", author: ade, created_at: "2026-10-12T10:00:00Z" },
  { id: id(1), version: 1, title: "P450 purification", note: null, author: ade, created_at: "2026-09-30T10:05:00Z" },
]);

export const protocolList = ProtocolListRows.parse([
  { id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0002", kind: "protocol", title: "Bradford assay", version: 2, author: jordan, updated_at: "2026-10-28T13:00:00Z" },
  { id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0019", kind: "protocol", title: "Cell viability (MTT)", version: 3, author: priya, updated_at: "2026-11-01T09:00:00Z" },
  { id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003", kind: "tutorial", title: "Imaging a gel on the ChemiDoc", version: 1, author: priya, updated_at: "2026-10-19T16:30:00Z" },
  { id: purificationId, kind: "protocol", title: "P450 BM3 purification", version: 4, author: priya, updated_at: "2026-11-02T15:20:00Z" },
  { id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0004", kind: "protocol", title: "SDS-PAGE for BM3 fractions", version: 3, author: ade, updated_at: "2026-10-15T11:10:00Z" },
  { id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0005", kind: "tutorial", title: "Using the sonicator safely", version: 1, author: ade, updated_at: "2026-09-29T08:45:00Z" },
]);

export const protocolHits = SearchProtocolsRows.parse([
  {
    id: purificationId,
    kind: "protocol",
    title: "P450 BM3 purification",
    version: 4,
    snippet: "6. Run fractions on an SDS-PAGE **gel** next to the ladder. BM3 runs near 119 kDa.",
  },
  {
    id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003",
    kind: "tutorial",
    title: "Imaging a gel on the ChemiDoc",
    version: 1,
    snippet: "## Exposure\nStart with auto exposure for Coomassie gels, then lower it if the bands saturate.",
  },
]);

// The original protocol PDF and the batch 3 gel, already in the search fixtures.
export const linkedFiles = searchHits.filter((h) => h.sha256.startsWith("b") || h.sha256.startsWith("a")).toReversed();

// A start file for /protocols/new?from=…: the purification PDF and its extracted text.
const [pdf] = FolderFilesRows.parse([
  {
    sha256: "b".repeat(64),
    file_kind: "pdf",
    mime: "application/pdf",
    size: 182_000,
    has_preview: true,
    snippet: null,
    locations: [
      {
        id: "7a1c2c39-5a4e-4c55-9d7b-0c3c1a7ac001",
        source_id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003",
        source_kind: "dropbox",
        path: "/Lab/Protocols/P450 purification v3.pdf",
        original_name: "P450 purification v3.pdf",
        modified_at: "2026-09-30T10:00:00Z",
      },
    ],
    label: null,
  },
]);

export const startFile = pdf === undefined
  ? null
  : {
      hit: pdf,
      text: `P450 BM3 purification, v3\n\nDay 1\n1. Resuspend pellet in 40 mL lysis buffer (50 mM Tris pH 8.0, 300 mM NaCl, 10 mM imidazole).\n2. Sonicate on ice, 10 s on / 20 s off, 5 min total.\n3. Spin 15,000 g, 30 min, 4 C. Keep supernatant.\n\nDay 2\n4. Load on 5 mL HisTrap at 1 mL/min.\n5. Wash 10 CV, elute 250 mM imidazole in 1 mL fractions.\n6. SDS-PAGE of fractions; BM3 ~119 kDa.`,
    };
