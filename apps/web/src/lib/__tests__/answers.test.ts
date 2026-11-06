import { describe, expect, it } from "vitest";
import { AskEvent, checkAnswer, looksLikeQuestion, normalizeCell, SentenceStream } from "../answers";
import { askLab, buildSources, cacheKey, normalizeQuestion, type AnswerWriter, type AskReads, type ContextRow, type ModelCall, type RecordAnswerArgs } from "../ask";
import type { DataTables } from "../data-tables";
import { ColumnId, LabId, LocationId, ProtocolId, ProtocolVersionId, Sha256, SourceId, UserId, QuestionId } from "../ids";
import { ModelUnavailable } from "../json-model";
import { foldDiff, lineDiff } from "../suggestions";
import { fakeJsonModel } from "./fake-model";

const lab = LabId.parse("00000000-0000-4000-8000-00000000aa01");
const user = UserId.parse("00000000-0000-4000-8000-00000000aa02");
const sha = (c: string) => Sha256.parse(c.repeat(64));

function fileRow(c: string, path: string, text: string, tableKey: string | null = null): ContextRow {
  return {
    sha256: sha(c),
    score: 1,
    file_kind: tableKey === null ? "text" : "spreadsheet",
    locations: [
      {
        id: LocationId.parse(`00000000-0000-4000-8000-0000000000${c}${c}`),
        sourceId: SourceId.parse("00000000-0000-4000-8000-00000000ab01"),
        sourceKind: "dropbox",
        path,
        originalName: path.split("/").at(-1) ?? path,
        modifiedAt: "2026-10-14T12:00:00Z",
      },
    ],
    label: null,
    excerpts: [{ ord: 1, text }],
    table_key: tableKey,
  };
}

const yields: DataTables = {
  version: 1,
  cellLimit: 200000,
  tables: [
    {
      name: "Yields",
      sheet: "Yields",
      notes: [],
      rows: 3,
      truncated: false,
      rowsInFile: null,
      columns: [
        { id: ColumnId.parse("A"), name: "Batch", kind: "text", unit: null, values: ["1", "2", "3"], invalid: 0 },
        { id: ColumnId.parse("B"), name: "Yield", kind: "number", unit: "mg", values: [4.1, 3.8, 5.2], invalid: 0 },
      ],
    },
  ],
};

const protocol = {
  protocol_id: ProtocolId.parse("00000000-0000-4000-8000-00000000ac01"),
  kind: "protocol" as const,
  title: "SEC run",
  version: 3,
  version_id: ProtocolVersionId.parse("00000000-0000-4000-8000-00000000ac02"),
  body: "1. Equilibrate in 20 mM HEPES pH 7.5, 150 mM NaCl.",
};

const built = () =>
  buildSources({
    files: [fileRow("a", "/P450/batch3/notes.txt", "Batch 3 lysed on ice, 30 min."), fileRow("b", "/P450/yields.xlsx", "", "tables/b.json")],
    protocols: [protocol],
    tables: new Map([[sha("b"), yields]]),
  });

describe("checking citations", () => {
  const shown = built().shown;

  it("keeps citations of sources the model was shown and drops invented ones", () => {
    const checked = checkAnswer(
      {
        sentences: [
          { text: "Batch 3 gave 5.2 mg.", citations: [{ source: "F2", cell: "Yields!B3" }, { source: "F9", cell: null }] },
          { text: "It was lysed on ice.", citations: [{ source: "f1", cell: null }] },
        ],
      },
      shown,
    );
    expect(checked.outcome).toBe("answered");
    expect(checked.droppedCitations).toBe(1);
    expect(checked.answer.sentences.map((s) => s.citations.map((c) => c.source))).toEqual([["F2"], ["F1"]]);
    expect(checked.answer.sentences[0]?.citations[0]?.cell).toEqual({ table: "Yields", column: "Yield (mg)", row: 3, value: "5.2" });
  });

  it("drops a sentence whose citations were all invented, and says not found when none is left", () => {
    const checked = checkAnswer(
      {
        sentences: [
          { text: "Batch 3 gave 9 mg.", citations: [{ source: "F7", cell: null }] },
          { text: "Everyone agreed.", citations: [] },
        ],
      },
      shown,
    );
    expect(checked).toEqual({ answer: { sentences: [] }, outcome: "not_found", droppedCitations: 1, droppedSentences: 2 });
  });

  it("keeps the file but not a cell the model wasn't shown", () => {
    const checked = checkAnswer({ sentences: [{ text: "Batch 4 gave 7 mg.", citations: [{ source: "F2", cell: "Yields!B9" }] }] }, shown);
    expect(checked.answer.sentences[0]?.citations).toEqual([{ source: "F2", cell: null }]);
  });

  it("reads one cell however it's written", () => {
    expect(normalizeCell("yields ! b03")).toBe(normalizeCell("Yields!B3"));
  });
});

describe("the sources the model sees", () => {
  it("numbers files and protocols, and shows tables by letter and row", () => {
    const { sources, rendered } = built();
    expect(sources.map((s) => s.key)).toEqual(["F1", "F2", "P1"]);
    expect(rendered).toContain('Table "Yields" (rows 1-3 of 3):');
    expect(rendered).toContain("row | A: Batch | B: Yield (mg)");
    expect(rendered).toContain("3 | 3 | 5.2");
    expect(rendered).toContain('<source id="P1" type="protocol">');
  });

  it("keys the cache on the question's words and the exact sources", () => {
    const a = cacheKey([1, "m", normalizeQuestion("What was the yield?  "), built().rendered]);
    expect(cacheKey([1, "m", normalizeQuestion("what was the YIELD"), built().rendered])).toBe(a);
    expect(cacheKey([1, "m", normalizeQuestion("what was the yield"), `${built().rendered} `])).not.toBe(a);
  });
});

describe("reading the reply as it streams", () => {
  it("hands back each sentence once its object closes", () => {
    const text = JSON.stringify({
      sentences: [
        { text: 'It said "5 mg" {sic}.', citations: [{ source: "F1", cell: null }] },
        { text: "Second.", citations: [{ source: "P1", cell: null }] },
      ],
    });
    const stream = new SentenceStream();
    const seen: string[][] = [];
    for (const ch of text) seen.push(stream.push(ch).map((s) => s.text));
    const flat = seen.flat();
    expect(flat).toEqual(['It said "5 mg" {sic}.', "Second."]);
    // The first arrives before the second has begun.
    expect(seen.findIndex((s) => s.length > 0)).toBeLessThan(text.indexOf("Second."));
  });
});

describe("asking", () => {
  type Recorded = RecordAnswerArgs;
  function harness({ cached = null, spent = 0, cap = 25, files = built() }: { cached?: ModelCall["output"] | null; spent?: number; cap?: number; files?: ReturnType<typeof built> | null } = {}) {
    const recorded: Recorded[] = [];
    const reads: AskReads = {
      context: async () => (files === null ? [] : [fileRow("a", "/P450/batch3/notes.txt", "Batch 3 lysed on ice, 30 min."), fileRow("b", "/P450/yields.xlsx", "", "tables/b.json")]),
      protocols: async () => (files === null ? [] : [protocol]),
      table: async () => yields,
      budget: async () => ({ capUsd: cap, spentUsd: spent, resetsAt: "2026-12-01T00:00:00Z" }),
    };
    const writer: AnswerWriter = {
      cachedOutput: async () => cached,
      recordAnswer: async (a) => {
        recorded.push(a);
        return QuestionId.parse("00000000-0000-4000-8000-00000000ad01");
      },
      recordSuggestion: async () => {
        throw new Error("asking never records a suggestion");
      },
      recordSpend: async () => undefined,
    };
    return { reads, writer, recorded };
  }
  const reply = { sentences: [{ text: "Batch 3 gave 5.2 mg.", citations: [{ source: "F2", cell: "Yields!B3" }] }, { text: "Made up.", citations: [{ source: "F8", cell: null }] }] };

  async function run(h: ReturnType<typeof harness>, model = fakeJsonModel(() => reply)) {
    const events: AskEvent[] = [];
    await askLab({ labId: lab, userId: user, reads: h.reads, writer: h.writer, model, embed: async () => ({ kind: "failed", reason: "embed_unconfigured" }), now: () => 0 }, "What was the yield of batch 3?", (e) => events.push(AskEvent.parse(e)));
    return { events, model };
  }

  it("streams checked sentences, then saves the answer with its paid call", async () => {
    const h = harness();
    const { events, model } = await run(h);
    expect(events.map((e) => e.type)).toEqual(["sources", "sentence", "done"]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.user).toContain("Question: What was the yield of batch 3?");
    const saved = h.recorded[0];
    expect(saved?.p_outcome).toBe("answered");
    expect(saved?.p_dropped_citations).toBe(1);
    expect(saved?.p_dropped_sentences).toBe(1);
    expect(saved?.p_call?.cost_usd).toBeCloseTo(0.008);
    expect(saved?.p_call?.cache_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers from the cache without calling the model or spending", async () => {
    const h = harness({ cached: { text: JSON.stringify(reply), stop_reason: "end_turn" } });
    const { events, model } = await run(h);
    expect(model.calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "done", cached: true, costUsd: 0, outcome: "answered" });
    expect(h.recorded[0]?.p_call).toBeNull();
  });

  it("stops at the month's cap, still showing the closest files", async () => {
    const h = harness({ spent: 25.01, cap: 25 });
    const { events, model } = await run(h);
    expect(model.calls).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["sources", "limit"]);
    expect(h.recorded).toHaveLength(0);
  });

  it("says not found without a model call when nothing in the lab matches", async () => {
    const h = harness({ files: null });
    const { events, model } = await run(h);
    expect(model.calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "not_found" });
    expect(h.recorded[0]?.p_model).toBeNull();
  });

  it("says not found when the model's every claim was uncited", async () => {
    const h = harness();
    const { events } = await run(h, fakeJsonModel(() => ({ sentences: [{ text: "Probably 5 mg.", citations: [] }] })));
    expect(events.filter((e) => e.type === "sentence")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "not_found" });
  });

  it("reports an unreachable model plainly", async () => {
    const h = harness();
    const down = { stream: async () => Promise.reject(new ModelUnavailable("overloaded", true)) };
    const { events } = await run(h, Object.assign(down, { calls: [] }));
    expect(events.at(-1)).toMatchObject({ type: "failed" });
    expect(h.recorded).toHaveLength(0);
  });
});

describe("questions on the Search page", () => {
  it("offers asking for questions, not plain searches", () => {
    expect(looksLikeQuestion("what was the yield of P450 batch 3?")).toBe(true);
    expect(looksLikeQuestion("which buffer did we use for the SEC run")).toBe(true);
    expect(looksLikeQuestion("p450 gels")).toBe(false);
    expect(looksLikeQuestion("batch 3 kinetics")).toBe(false);
  });
});

describe("the protocol edit diff", () => {
  it("marks added and removed lines and folds long unchanged runs", () => {
    const before = ["1. Thaw.", "2. Lyse.", "3. Spin.", "4. Load.", "5. Wash.", "6. Elute.", "7. Pool."].join("\n");
    const after = ["1. Thaw.", "2. Lyse.", "3. Spin 10 min at 4 C.", "4. Load.", "5. Wash.", "6. Elute.", "7. Pool."].join("\n");
    const diff = lineDiff(before, after);
    expect(diff.filter((l) => l.kind !== "same")).toEqual([
      { kind: "removed", text: "3. Spin." },
      { kind: "added", text: "3. Spin 10 min at 4 C." },
    ]);
    expect(foldDiff(diff, 1).map((b) => b.kind)).toEqual(["folded", "lines", "folded"]);
  });

  it("shows an inserted step as one added line, not every renumbered step after it", () => {
    const diff = lineDiff("1. Thaw.\n2. Spin.\n3. Load.\n4. Wash.", "1. Thaw.\n2. Spin.\n3. Filter.\n4. Load.\n5. Wash.");
    expect(diff).toEqual([
      { kind: "same", text: "1. Thaw." },
      { kind: "same", text: "2. Spin." },
      { kind: "added", text: "3. Filter." },
      { kind: "same", text: "4. Load." },
      { kind: "same", text: "5. Wash." },
    ]);
  });
});

