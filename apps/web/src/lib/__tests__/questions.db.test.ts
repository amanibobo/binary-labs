import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questionsPage, RecentQuestionRows, type QuestionsQuery } from "../answers";
import { CreateLabResult } from "../domain";
import { LabId, UserId } from "../ids";
import { asRole, rows, scalar } from "./pg-ask";

// search_questions through the web app's parser and paging, against the real migrations.

const db = new Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://localhost/binary_labs_web_test" });
const dana = UserId.parse("00000000-0000-4000-8000-0000000d0001");
const eli = UserId.parse("00000000-0000-4000-8000-0000000d0002");
const member = (userId: UserId) => ({ kind: "member" as const, userId });

let lab: LabId;
let other: LabId;

const answer = (text: string) => JSON.stringify({ sentences: text === "" ? [] : [{ text, citations: [{ source: "F1", cell: null }] }] });

async function page(userId: UserId, labId: LabId, query: QuestionsQuery, size: number) {
  const raw = await asRole(db, member(userId), () =>
    rows(db, "search_questions($1, $2, $3::timestamptz, $4::uuid, $5)", [labId, query.q ?? null, query.before?.at ?? null, query.before?.id ?? null, size + 1]),
  );
  return questionsPage(RecentQuestionRows.parse(raw), size);
}

beforeAll(async () => {
  await db.connect();
  await db.query("insert into auth.users (id, email) values ($1, 'dana.q@questions.edu'), ($2, 'eli.q@questions.edu')", [dana, eli]);
  lab = CreateLabResult.parse(await asRole(db, member(dana), async () => scalar(db, "create_lab('Questions Lab')", [])));
  other = CreateLabResult.parse(await asRole(db, member(eli), async () => scalar(db, "create_lab('Other Questions Lab')", [])));
  const asked: [LabId, string, string, string][] = [
    [lab, "What was the A420/A280 ratio for batch 1?", "The ratio was 1.4 after the SEC column.", "2026-10-27T09:15:00Z"],
    [lab, "Where is the Bradford standard curve from Oct 30?", "It is in bradford_oct30.xlsx.", "2026-10-31T15:00:00Z"],
    [lab, "How long do we spin the lysate?", "Spin 30 minutes at 4 C.", "2026-11-03T16:45:00Z"],
    [lab, "Did anyone run a thermal shift on A82F?", "", "2026-11-04T10:02:00Z"],
    [other, "What was the yield of batch 1?", "Only the other lab knows.", "2026-11-05T10:00:00Z"],
  ];
  for (const [labId, question, text, at] of asked) {
    await db.query(
      `insert into questions (lab_id, asked_by, question, outcome, answer, sources, asked_at)
       values ($1, $2, $3, $4, $5::jsonb, '[]', $6)`,
      [labId, labId === lab ? dana : eli, question, text === "" ? "not_found" : "answered", answer(text), at],
    );
  }
});

afterAll(async () => {
  await db.end();
});

describe("search_questions", () => {
  it("lists every question in the lab, newest first, with who asked", async () => {
    const all = await page(dana, lab, {}, 50);
    expect(all.questions.map((q) => q.question)).toEqual([
      "Did anyone run a thermal shift on A82F?",
      "How long do we spin the lysate?",
      "Where is the Bradford standard curve from Oct 30?",
      "What was the A420/A280 ratio for batch 1?",
    ]);
    expect(all.questions[0]).toMatchObject({ askedBy: dana, askedByEmail: "dana.q@questions.edu", outcome: "not_found" });
    expect(all.next).toBeNull();
  });

  it("finds a question by every word, in the question or its answer, prefixes included", async () => {
    const qs = async (q: string) => (await page(dana, lab, { q }, 50)).questions.map((x) => x.question);
    expect(await qs("bradford")).toEqual(["Where is the Bradford standard curve from Oct 30?"]);
    expect(await qs("A420")).toEqual(["What was the A420/A280 ratio for batch 1?"]);
    expect(await qs("SEC column")).toEqual(["What was the A420/A280 ratio for batch 1?"]);
    expect(await qs("spin minutes")).toEqual(["How long do we spin the lysate?"]);
    expect(await qs("brad")).toEqual(["Where is the Bradford standard curve from Oct 30?"]);
    expect(await qs("bradford lysate")).toEqual([]);
    // Only stop words is no search at all.
    expect(await qs("the")).toHaveLength(4);
  });

  it("pages from the last question of the page before, with no repeats or gaps", async () => {
    const first = await page(dana, lab, {}, 3);
    expect(first.questions).toHaveLength(3);
    if (first.next === null) throw new Error("expected a next page");
    const second = await page(dana, lab, { before: first.next }, 3);
    expect(second.questions.map((q) => q.question)).toEqual(["What was the A420/A280 ratio for batch 1?"]);
    expect(second.next).toBeNull();
  });

  it("shows nothing of another lab", async () => {
    expect((await page(eli, lab, {}, 50)).questions).toEqual([]);
    expect((await page(dana, lab, { q: "yield" }, 50)).questions).toEqual([]);
    expect((await page(eli, other, {}, 50)).questions.map((q) => q.question)).toEqual(["What was the yield of batch 1?"]);
  });
});
