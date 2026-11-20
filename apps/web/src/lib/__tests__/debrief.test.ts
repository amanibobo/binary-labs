import { describe, expect, it } from "vitest";
import {
  answerText,
  DEBRIEF_QUESTIONS,
  debriefAnswerHeaders,
  DebriefChange,
  debriefFailure,
  DebriefJson,
  holdup,
  missingQuestions,
  parseDebriefAnswerHeaders,
  type DebriefAnswer,
} from "../debrief";
import { DebriefId, LocationId } from "../ids";

const audio = LocationId.parse("6a2b1c3d-7e4f-4a5b-9c6d-0e1f2a3b0001");
const id = DebriefId.parse("5e1d0c2a-6b1f-4a7e-8d3c-0d0b2f1e0001");
const heard = (transcript: string, correction: string | null = null) =>
  ({ kind: "recording", audio, heard: { kind: "heard", transcript }, correction }) as const;

describe("the six questions", () => {
  it("are the cofounder's, word for word, in order", () => {
    expect(DEBRIEF_QUESTIONS.map((q) => q.ask)).toEqual([
      "What were you trying to do?",
      "What did you expect, and what did you see?",
      "What do you think went wrong?",
      "How did you find out?",
      "What did you change, and did it fix it?",
      "Who else confirmed it, or could?",
    ]);
  });
});

describe("answerText", () => {
  it("is what was typed, else the correction, else the transcript, trimmed; nothing is null", () => {
    expect(answerText({ kind: "typed", text: " Fresh IPTG. " })).toBe("Fresh IPTG.");
    expect(answerText(heard("the ipt g was old", "The IPTG was old."))).toBe("The IPTG was old.");
    expect(answerText(heard("The IPTG was old."))).toBe("The IPTG was old.");
    expect(answerText(heard("Something.", ""))).toBeNull();
    expect(answerText(heard("   "))).toBeNull();
    expect(answerText({ kind: "recording", audio, heard: { kind: "transcribing" }, correction: null })).toBeNull();
    expect(answerText({ kind: "none" })).toBeNull();
  });
});

describe("what holds up saving", () => {
  const a = (question: DebriefAnswer["question"], words: DebriefAnswer["words"], fixWorked: DebriefAnswer["fixWorked"] = null): DebriefAnswer => ({ question, words, fixWorked });

  it("a transcript still coming, then a recording nobody could make out; a correction clears either", () => {
    const transcribing = a(1, { kind: "recording", audio, heard: { kind: "transcribing" }, correction: null });
    const failed = a(2, { kind: "recording", audio, heard: { kind: "failed", message: "x" }, correction: null });
    expect(holdup({ answers: [transcribing, failed] })).toEqual({ kind: "transcribing", questions: [1] });
    expect(holdup({ answers: [failed] })).toEqual({ kind: "not_heard", questions: [2] });
    expect(holdup({ answers: [a(2, { kind: "recording", audio, heard: { kind: "failed", message: "x" }, correction: "Typed over it." })] })).toBeNull();
  });

  it("missing is every question with no words, except question 5 with a tap", () => {
    expect(missingQuestions({ answers: [] })).toEqual([1, 2, 3, 4, 5, 6]);
    expect(missingQuestions({ answers: [a(1, { kind: "typed", text: "Aim." }), a(3, heard("  ")), a(5, { kind: "none" }, "yes")] })).toEqual([2, 3, 4, 6]);
  });
});

describe("debrief_json", () => {
  it("reads a recording's state from its place in the lab, and keeps the correction beside the transcript", () => {
    const parsed = DebriefJson.parse({
      id,
      run_id: "7d1c2c39-5a4e-4c55-9d7b-0c3c1a7d0001",
      state: "open",
      started_by: null,
      started_at: "2026-11-20T10:00:00Z",
      approved_at: null,
      answers: [
        { question: 1, typed: false, text: null, fix_worked: null, recording: { location_id: audio, index_state: "pending", error: null, transcript: null } },
        { question: 2, typed: false, text: "Fixed.", fix_worked: null, recording: { location_id: audio, index_state: "indexed", error: null, transcript: "fixd" } },
        { question: 3, typed: false, text: null, fix_worked: null, recording: { location_id: audio, index_state: "failed", error: "no speech", transcript: null } },
        { question: 4, typed: true, text: "Typed.", fix_worked: null, recording: null },
        { question: 5, typed: false, text: null, fix_worked: "not_sure", recording: null },
      ],
    });
    expect(parsed.answers.map((x) => x.words)).toEqual([
      { kind: "recording", audio, heard: { kind: "transcribing" }, correction: null },
      { kind: "recording", audio, heard: { kind: "heard", transcript: "fixd" }, correction: "Fixed." },
      { kind: "recording", audio, heard: { kind: "failed", message: "We couldn't make out this recording. Record it again or type it." }, correction: null },
      { kind: "typed", text: "Typed." },
      { kind: "none" },
    ]);
    expect(parsed.answers[4]?.fixWorked).toBe("not_sure");
  });
});

describe("the upload's headers", () => {
  it("round-trip, and a question outside 1 to 6 or a missing debrief is refused", () => {
    const meta = { debriefId: id, question: 3 as const, name: "Debrief 2026-11-20 10.00.00 question 3.weba", uploadedOn: "2026-11-20" };
    expect(parseDebriefAnswerHeaders(new Headers(debriefAnswerHeaders(meta)))).toEqual(meta);
    expect(parseDebriefAnswerHeaders(new Headers({ ...debriefAnswerHeaders(meta), "x-debrief-question": "7" }))).toBeNull();
    const noDebrief = new Headers(debriefAnswerHeaders(meta));
    noDebrief.delete("x-debrief-id");
    expect(parseDebriefAnswerHeaders(noDebrief)).toBeNull();
  });
});

describe("what the browser sends", () => {
  it("is one of three changes", () => {
    expect(DebriefChange.parse({ action: "text", question: 2, text: "x", correction: true })).toMatchObject({ action: "text" });
    expect(DebriefChange.safeParse({ action: "text", question: 9, text: "x", correction: false }).success).toBe(false);
    expect(DebriefChange.safeParse({ action: "fix", fix: "maybe" }).success).toBe(false);
    expect(DebriefChange.safeParse({ action: "approve" }).success).toBe(false);
  });

  it("a refusal from the database has plain words; anything else is a 500", () => {
    expect(debriefFailure({ code: "BL944" })).toEqual({ status: 409, message: "An answer is still being written out. Wait a moment, then try again." });
    expect(debriefFailure({ code: "XX000" }).status).toBe(500);
  });
});
