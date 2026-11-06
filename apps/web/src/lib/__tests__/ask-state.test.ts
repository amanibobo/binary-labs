import { describe, expect, it } from "vitest";
import type { AskEvent, AskStep } from "../answers";
import { activityRows, activitySummary, askReducer, searchResultWords, upsertStep, type AskState } from "../ask-state";
import { answerSentences, answerSources, doneOf, retrievalSteps, savedAnswer, writeStep } from "@/fixtures/answers";

// The answer box's state as the route's events arrive, and the activity list built from it.

const question = "What was the yield of P450 batch 3?";
const steps = retrievalSteps(question, answerSources);

function feed(events: AskEvent[], from: AskState = askReducer({ kind: "idle" }, { type: "ask", question })): AskState {
  return events.reduce((state, event) => askReducer(state, { type: "event", event }), from);
}

const stepEvent = (step: AskStep): AskEvent => ({ type: "step", step });
const kinds = (list: readonly AskStep[]) => list.map((s) => s.kind);

describe("the steps as they arrive", () => {
  it("shows the search running, then replaces it with what it found", () => {
    const running = feed([stepEvent(steps.running)]);
    expect(running.kind === "asking" && running.steps).toEqual([steps.running]);
    const found = feed([stepEvent(steps.running), stepEvent(steps.done[0] ?? steps.running)]);
    expect(found.kind === "asking" && found.steps).toHaveLength(1);
    expect(found.kind === "asking" && found.steps[0]).toMatchObject({ kind: "search", found: { files: 5, protocols: 1 } });
  });

  it("keeps the steps in the order they started, whatever order they come in", () => {
    const [search, a, b] = steps.done;
    if (search === undefined || a === undefined || b === undefined) throw new Error("fixture has too few steps");
    expect(upsertStep(upsertStep([search], b), a).map((s) => s.id)).toEqual([0, 1, 2]);
  });

  it("carries the steps into the answer, the cap and a failure", () => {
    const all = [...steps.done, writeStep(answerSources, false)].map(stepEvent);
    const answered = feed([...all, { type: "sources", sources: answerSources }, ...answerSentences.map((sentence): AskEvent => ({ type: "sentence", sentence })), doneOf(answerSentences, "answered")]);
    expect(answered.kind).toBe("answered");
    expect(answered.kind === "answered" && kinds(answered.steps)).toEqual(["search", "file", "file", "file", "file", "file", "protocol", "table", "write"]);

    const limited = feed([...steps.done.map(stepEvent), { type: "limit", budget: { capUsd: 25, spentUsd: 26, resetsAt: "2026-12-01T00:00:00Z" } }]);
    expect(limited.kind === "limit" && limited.steps).toHaveLength(steps.done.length);

    const failed = feed([...all, { type: "failed", message: "down" }]);
    expect(failed.kind === "failed" && failed.steps.at(-1)).toMatchObject({ kind: "write" });

    const lost = askReducer(feed(all), { type: "lost", message: "gone" });
    expect(lost.kind === "failed" && lost.steps).toHaveLength(all.length);
  });

  it("starts each question with no steps and ignores steps from one that was closed", () => {
    const first = feed(steps.done.map(stepEvent));
    const again = askReducer(first, { type: "ask", question: "Which gel?" });
    expect(again.kind === "asking" && again.steps).toEqual([]);
    const closed = askReducer(first, { type: "close" });
    expect(feed([stepEvent(steps.running)], closed)).toEqual({ kind: "idle" });
  });

  it("opens a saved answer with the steps saved beside it", () => {
    const opened = askReducer({ kind: "idle" }, { type: "opened", saved: savedAnswer });
    expect(opened.kind === "answered" && opened.steps).toEqual(savedAnswer.steps);
    expect(opened.kind === "answered" && opened.askedAt).toBe(savedAnswer.askedAt);
  });
});

describe("the activity list", () => {
  it("puts files, protocols and tables read one after another on one line each", () => {
    const rows = activityRows([...steps.done, writeStep(answerSources, false)]);
    expect(rows.map((r) => r.kind)).toEqual(["search", "file", "protocol", "table", "write"]);
    const files = rows[1];
    expect(files?.kind === "file" && files.steps.map((s) => s.name)).toEqual(["Batch 3 yields", "Bench notes, Oct 14", "Batch 3 SDS-PAGE gel", "SEC trace, Oct 14", "P450 BM3 purification protocol, v3"]);
  });

  it("starts a new line for files a second search read", () => {
    const second: AskStep[] = [
      { kind: "search", id: 20, query: "batch 3 yield", found: { files: 1, protocols: 0, byMeaning: true } },
      { kind: "file", id: 21, source: "F7", name: "Batch 3 notes", fileKind: "text" },
    ];
    expect(activityRows([...steps.done, ...second]).map((r) => r.kind)).toEqual(["search", "file", "protocol", "table", "search", "file"]);
  });

  it("folds into one line that counts what was read", () => {
    expect(activitySummary([...steps.done, writeStep(answerSources, false)])).toBe("Searched once · read 5 files, 1 protocol and 1 table");
    const one: AskStep[] = [
      { kind: "search", id: 0, query: "q", found: { files: 1, protocols: 0, byMeaning: true } },
      { kind: "file", id: 1, source: "F1", name: "a", fileKind: "text" },
      { kind: "search", id: 2, query: "q2", found: { files: 0, protocols: 0, byMeaning: true } },
    ];
    expect(activitySummary(one)).toBe("Searched twice · read 1 file");
    expect(activitySummary([{ kind: "search", id: 0, query: "q", found: { files: 0, protocols: 0, byMeaning: false } }])).toBe("Searched once · nothing matched");
  });

  it("says what a search found in words", () => {
    expect(searchResultWords({ files: 6, protocols: 1, byMeaning: true })).toBe("6 files and 1 protocol");
    expect(searchResultWords({ files: 1, protocols: 0, byMeaning: true })).toBe("1 file");
    expect(searchResultWords({ files: 0, protocols: 2, byMeaning: true })).toBe("2 protocols");
    expect(searchResultWords({ files: 0, protocols: 0, byMeaning: true })).toBe("0 files");
  });
});
