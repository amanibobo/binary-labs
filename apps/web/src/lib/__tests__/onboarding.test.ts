import { describe, expect, it } from "vitest";
import {
  applyEvent,
  checklist,
  FRESH_STATE,
  noteArgs,
  NO_PROGRESS,
  OnboardingRows,
  progressText,
  summarize,
  tourSteps,
  type Progress,
} from "../onboarding";

const at = (day: number) => `2026-11-0${day}T12:00:00.000Z`;

describe("checklist", () => {
  it("gives admins the setup items and members their everyday ones", () => {
    expect(checklist({ role: "admin", progress: NO_PROGRESS, state: FRESH_STATE }).map((i) => i.id)).toEqual([
      "files",
      "invite",
      "search",
      "protocol",
      "upload",
    ]);
    expect(checklist({ role: "member", progress: NO_PROGRESS, state: FRESH_STATE }).map((i) => i.id)).toEqual([
      "tour",
      "search",
      "fix",
      "upload",
    ]);
  });

  it("ticks only what the lab has actually done", () => {
    const progress: Progress = { ...NO_PROGRESS, dropboxAt: at(1), searchedAt: at(2) };
    const items = checklist({ role: "admin", progress, state: FRESH_STATE });
    expect(Object.fromEntries(items.map((i) => [i.id, i.doneAt]))).toEqual({
      files: at(1),
      invite: null,
      search: at(2),
      protocol: null,
      upload: null,
    });
    expect(progressText(summarize(items))).toBe("2 of 5");
  });

  it("counts a lab that only uploads as having its files, from the first of the two", () => {
    const uploadsOnly = checklist({ role: "admin", progress: { ...NO_PROGRESS, labUploadAt: at(3) }, state: FRESH_STATE });
    expect(uploadsOnly.find((i) => i.id === "files")?.doneAt).toBe(at(3));
    const both = checklist({ role: "admin", progress: { ...NO_PROGRESS, labUploadAt: at(3), dropboxAt: at(4) }, state: FRESH_STATE });
    expect(both.find((i) => i.id === "files")?.doneAt).toBe(at(3));
  });

  it("ticks a member's tour only when it was finished, not skipped", () => {
    const tour = (how: "done" | "skipped") =>
      checklist({ role: "member", progress: NO_PROGRESS, state: { ...FRESH_STATE, tourEnded: { how, at: at(2) } } }).find((i) => i.id === "tour");
    expect(tour("done")?.doneAt).toBe(at(2));
    expect(tour("skipped")?.doneAt).toBeNull();
  });

  it("completes at the latest item, for time to first value", () => {
    const progress: Progress = { ...NO_PROGRESS, dropboxAt: at(1), invitedAt: at(4), searchedAt: at(2), protocolAt: at(3), uploadedAt: at(2) };
    expect(summarize(checklist({ role: "admin", progress, state: FRESH_STATE }))).toEqual({ kind: "complete", total: 5, completedAt: at(4) });
  });
});

describe("tour", () => {
  it("follows the PRD's member tour, with the setup step first for admins", () => {
    expect(tourSteps("member").map((s) => s.id)).toEqual(["search", "open", "fix", "needs-look"]);
    expect(tourSteps("admin").map((s) => s.id)).toEqual(["setup", "search", "open", "fix", "needs-look"]);
  });

  it("falls back to the phone's menu for sidebar steps", () => {
    for (const step of tourSteps("admin").filter((s) => s.id === "setup" || s.id === "needs-look")) {
      expect(step.anchors.at(-1)).toBe('[data-tour~="menu"]');
    }
  });
});

describe("onboarding events", () => {
  it("only moves the tour step forward, and starting over clears how it ended", () => {
    const ended = applyEvent(applyEvent(FRESH_STATE, { kind: "tour_step", step: 3 }, at(1)), { kind: "tour_skipped" }, at(1));
    expect(applyEvent(ended, { kind: "tour_step", step: 2 }, at(2))).toMatchObject({ tourStep: 3, tourEnded: { how: "skipped" } });
    expect(applyEvent(ended, { kind: "tour_step", step: 1 }, at(2))).toMatchObject({ tourStep: 3, tourEnded: null });
  });

  it("keeps a finished tour finished when it's skipped later", () => {
    const done = applyEvent(FRESH_STATE, { kind: "tour_done" }, at(1));
    expect(applyEvent(done, { kind: "tour_skipped" }, at(2)).tourEnded).toEqual({ how: "done", at: at(1) });
  });

  it("records a hint once", () => {
    const once = applyEvent(FRESH_STATE, { kind: "hint", hint: "check-this" }, at(1));
    expect(applyEvent(once, { kind: "hint", hint: "check-this" }, at(1)).hintsSeen).toEqual(["check-this"]);
  });

  it("sends the database a kind and its value", () => {
    expect(noteArgs({ kind: "tour_step", step: 4 })).toEqual({ p_kind: "tour_step", p_value: "4" });
    expect(noteArgs({ kind: "hint", hint: "phone-upload" })).toEqual({ p_kind: "hint", p_value: "phone-upload" });
    expect(noteArgs({ kind: "welcome" })).toEqual({ p_kind: "welcome", p_value: null });
  });

  it("reads no row as a fresh start and drops hint ids it doesn't know", () => {
    expect(OnboardingRows.parse([])).toEqual(FRESH_STATE);
    const row = { welcome_seen_at: at(1), tour_step: 2, tour_ended: null, tour_ended_at: null, checklist_hidden_at: null, hints_seen: ["check-this", "later-hint"] };
    expect(OnboardingRows.parse([row])).toMatchObject({ welcomeSeen: true, tourStep: 2, hintsSeen: ["check-this"] });
  });
});
