import { describe, expect, it } from "vitest";
import {
  parseQuestionsQuery,
  questionHref,
  questionsPage,
  questionsSearchParams,
  RecentQuestion,
  type QuestionsQuery,
} from "../answers";
import { PLAIN_LABEL, SearchFilesRows, SearchParams, type FileHit, type Label } from "../domain";
import { matchesFilters, searchQueryString } from "../filters";
import { QuestionId } from "../ids";
import { rowShortcut } from "../row-keys";
import { searchFilesArgs } from "../search";
import { LabId } from "../ids";

const [base] = SearchFilesRows.parse([
  {
    sha256: "c".repeat(64),
    score: 1,
    keyword_rank: null,
    vector_rank: null,
    snippet: null,
    file_kind: "spreadsheet",
    mime: "text/csv",
    size: 1,
    has_preview: false,
    locations: [
      {
        id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0002",
        source_id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0003",
        source_kind: "dropbox",
        path: "/Lab/Plates/plate3.csv",
        original_name: "plate3.csv",
        modified_at: "2026-10-14T10:00:00+00:00",
      },
    ],
    label: null,
  },
]);
if (base === undefined) throw new Error("fixture did not parse");

type Status = Exclude<Label["status"], "needs_look">;
const label = ({ status = "suggested", outcome = null }: { status?: Status; outcome?: Label["outcome"] }): Label => ({
  ...PLAIN_LABEL,
  status,
  cleanName: "Plate 3 IC50",
  date: null,
  experiment: null,
  person: null,
  instrument: null,
  tags: [],
  confidence: 0.9,
  outcome,
});
const needsLookLabel = (outcome: Label["outcome"]): Label => ({
  ...PLAIN_LABEL,
  status: "needs_look",
  cleanName: null,
  date: null,
  experiment: null,
  person: null,
  instrument: null,
  tags: [],
  confidence: 0.2,
  outcome,
});
const withLabel = (l: Label | null): FileHit => ({ ...base, label: l });

describe("outcome and Check this filters on recent files", () => {
  it("keeps only files whose label has the outcome", () => {
    expect(matchesFilters(withLabel(label({ outcome: "failed" })), { outcome: "failed" })).toBe(true);
    expect(matchesFilters(withLabel(label({ outcome: "worked" })), { outcome: "failed" })).toBe(false);
    expect(matchesFilters(withLabel(label({ outcome: null })), { outcome: "failed" })).toBe(false);
    expect(matchesFilters(withLabel(null), { outcome: "failed" })).toBe(false);
  });

  it("never matches an outcome on a file in Needs a look, which shows none", () => {
    expect(matchesFilters(withLabel(needsLookLabel("failed")), { outcome: "failed" })).toBe(false);
  });

  it("keeps only Check this labels, and combines with the outcome", () => {
    const check = withLabel(label({ status: "check", outcome: "repeat" }));
    expect(matchesFilters(check, { check: true })).toBe(true);
    expect(matchesFilters(withLabel(label({ status: "accepted" })), { check: true })).toBe(false);
    expect(matchesFilters(check, { check: true, outcome: "repeat" })).toBe(true);
    expect(matchesFilters(check, { check: true, outcome: "failed" })).toBe(false);
  });
});

describe("filters on the wire", () => {
  it("round-trips through the query string /api/search parses", () => {
    const params: SearchParams = { q: "plate 3", outcome: "repeat", check: true, kind: "spreadsheet" };
    const back = SearchParams.parse(Object.fromEntries(new URLSearchParams(searchQueryString(params))));
    expect(back).toEqual(params);
  });

  it("refuses an outcome that isn't one and a check that isn't true", () => {
    expect(SearchParams.safeParse({ q: "x", outcome: "broken" }).success).toBe(false);
    expect(SearchParams.safeParse({ q: "x", check: "false" }).success).toBe(false);
  });

  it("passes them to search_files as an outcome list and a flag", () => {
    const labId = LabId.parse("6f1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001");
    const set = searchFilesArgs({ labId, params: { q: "x", outcome: "failed", check: true }, embedding: null });
    expect([set.p_outcomes, set.p_check_only]).toEqual([["failed"], true]);
    const unset = searchFilesArgs({ labId, params: { q: "x" }, embedding: null });
    expect([unset.p_outcomes, unset.p_check_only]).toEqual([null, false]);
  });
});

describe("row shortcuts", () => {
  const press = (key: string, over: Partial<Parameters<typeof rowShortcut>[0]> = {}) =>
    rowShortcut({ key, modified: false, repeat: false, typing: false, sheet: true, ...over });

  it("E edits labels and C makes a chart from a data sheet", () => {
    expect(press("e")).toBe("edit");
    expect(press("E")).toBe("edit");
    expect(press("c")).toBe("chart");
    expect(press("c", { sheet: false })).toBeNull();
    expect(press("x")).toBeNull();
  });

  it("never fires while typing, with a modifier, or on a repeat", () => {
    expect(press("e", { typing: true })).toBeNull();
    expect(press("c", { typing: true })).toBeNull();
    expect(press("c", { modified: true })).toBeNull();
    expect(press("e", { repeat: true })).toBeNull();
  });
});

const question = (i: number): RecentQuestion =>
  RecentQuestion.parse({
    id: `8a1c2c39-5a4e-4c55-9d7b-0c3c1a7a${String(i).padStart(4, "0")}`,
    question: `Question ${i}?`,
    outcome: "answered",
    askedBy: null,
    askedByEmail: null,
    askedAt: `2026-10-${String(30 - i).padStart(2, "0")}T10:00:00Z`,
  });

describe("the Questions page's pages", () => {
  it("offers a next page only when there's a row past this one, starting after its last", () => {
    const rows = [1, 2, 3, 4].map(question);
    const full = questionsPage(rows, 3);
    expect(full.questions.map((q) => q.question)).toEqual(["Question 1?", "Question 2?", "Question 3?"]);
    expect(full.next).toEqual({ at: rows[2]?.askedAt, id: rows[2]?.id });
    expect(questionsPage(rows.slice(0, 3), 3).next).toBeNull();
    expect(questionsPage([], 3)).toEqual({ questions: [], next: null });
  });

  it("round-trips the search and the cursor, and refuses half a cursor", () => {
    const query: QuestionsQuery = { q: "bradford", before: { at: "2026-10-30T10:00:00Z", id: QuestionId.parse("8a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001") } };
    expect(parseQuestionsQuery(questionsSearchParams(query))).toEqual(query);
    expect(parseQuestionsQuery(new URLSearchParams())).toEqual({});
    expect(parseQuestionsQuery(new URLSearchParams({ before_at: "2026-10-30T10:00:00Z" }))).toBeNull();
    expect(parseQuestionsQuery(new URLSearchParams({ before_at: "soon", before_id: "8a1c2c39-5a4e-4c55-9d7b-0c3c1a7a0001" }))).toBeNull();
  });

  it("opens a question on Search with it typed in and its answer open", () => {
    const q = question(1);
    const url = new URL(questionHref(q), "http://x");
    expect(url.pathname).toBe("/");
    expect([url.searchParams.get("q"), url.searchParams.get("ask")]).toEqual(["Question 1?", q.id]);
  });
});
