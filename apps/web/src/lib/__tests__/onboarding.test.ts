import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NAV, SETTINGS_NAV } from "@/components/nav";
import { CLIP_SIZES } from "@/components/onboarding/clip-sizes";
import {
  applyEvent,
  checklist,
  FRESH_STATE,
  HELP_ANSWERS,
  helpGroups,
  START_POINTER,
  type ClipId,
  noteArgs,
  NO_PROGRESS,
  OnboardingRows,
  progressText,
  summarize,
  tourSteps,
  type Progress,
} from "../onboarding";

// Sentence ends: a full stop, question or exclamation mark before a space or the end.
const sentences = (text: string) => text.split(/[.!?](?:\s|$)/).filter((part) => part.trim() !== "").length;

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
  // Saved progress is a step number, so the order is part of the contract: change it on purpose.
  it("keeps one step per tab, in the sidebar's order, ending on Help", () => {
    const ids = ["search", "browse", "runs", "protocols", "map", "calendar", "needs-look", "flags", "upload", "settings", "help"];
    expect(tourSteps("member").map((s) => s.id)).toEqual(ids);
    expect(tourSteps("admin").map((s) => s.id)).toEqual(ids);
  });

  it("spotlights each tab's sidebar link, found by its name there, with the phone's menu last", () => {
    const sidebar = new Map<string, string>([...NAV, SETTINGS_NAV].map((item) => [item.label, item.section]));
    sidebar.set("Help", "help");
    for (const step of tourSteps("member")) {
      const section = sidebar.get(step.title);
      expect(section, step.title).toBeDefined();
      expect(step.anchors[0]).toBe(`[data-tour~="${section}"]`);
      expect(step.anchors.at(-1)).toBe('[data-tour~="menu"]');
    }
    // Every sidebar tab has its step.
    expect(new Set(tourSteps("member").map((s) => s.title))).toEqual(new Set(sidebar.keys()));
  });

  it("tells admins to set the lab up from Settings", () => {
    const settings = (role: "admin" | "member") => tourSteps(role).find((s) => s.id === "settings")?.when;
    expect(settings("admin")).toMatch(/connect Dropbox and invite/);
    expect(settings("member")).not.toBe(settings("admin"));
  });

  it("stays short: a name, then one sentence on what it's for and one on when", () => {
    for (const role of ["admin", "member"] as const) {
      for (const step of tourSteps(role)) {
        expect(step.title.length, step.id).toBeLessThanOrEqual(16);
        for (const line of [step.what, step.when]) {
          expect(line.length, line).toBeLessThanOrEqual(110);
          expect(sentences(line), line).toBe(1);
        }
      }
    }
    // About a minute: 11 steps of a few seconds' reading each, 22 words a step.
    const words = tourSteps("member").reduce((n, s) => n + `${s.what} ${s.when}`.split(/\s+/).length, 0);
    expect(words).toBeLessThanOrEqual(242);
  });

  it("points to Protocols after the tour, in one line", () => {
    expect(START_POINTER.anchors).toEqual(['[data-tour~="protocols"]', '[data-tour~="menu"]']);
    expect(sentences(START_POINTER.text)).toBeLessThanOrEqual(2);
    expect(START_POINTER.text.length).toBeLessThanOrEqual(90);
  });
});

describe("how do I", () => {
  it("answers each question in one or two short sentences", () => {
    for (const answer of HELP_ANSWERS) {
      expect(answer.question.length, answer.question).toBeLessThanOrEqual(36);
      expect(answer.answer.length, answer.id).toBeLessThanOrEqual(230);
      expect(sentences(answer.answer), answer.id).toBeLessThanOrEqual(2);
    }
    expect(new Set(HELP_ANSWERS.map((a) => a.id)).size).toBe(HELP_ANSWERS.length);
  });

  it("covers the newer parts of the app", () => {
    const ids = HELP_ANSWERS.map((a) => a.id);
    for (const id of ["ask", "old-questions", "filter", "keys", "many-labels", "repeat", "make-run", "map", "calendar", "flag", "chart", "wells", "standard-curve", "ic50", "test", "export", "invite"] as const) {
      expect(ids).toContain(id);
    }
  });

  it("puts every answer under a group, with no empty group", () => {
    const groups = helpGroups();
    expect(groups.flatMap((g) => g.answers).length).toBe(HELP_ANSWERS.length);
    for (const g of groups) expect(g.answers.length).toBeGreaterThan(0);
  });
});

describe("clips", () => {
  const dir = join(import.meta.dirname, "../../../public/onboarding");
  const used = new Set<ClipId>([
    ...tourSteps("admin").map((s) => s.clip),
    ...HELP_ANSWERS.flatMap((a) => (a.clip === null ? [] : [a.clip])),
    "search", // the welcome's
  ]);
  const files = (clip: string) => ["dark", "light"].flatMap((scheme) => ["mp4", "webm", "webp"].map((ext) => `${clip}-${scheme}.${ext}`));

  it("has every clip a step, an answer or the welcome shows, in both themes, with its size", () => {
    for (const clip of used) {
      expect(CLIP_SIZES[clip], clip).toBeDefined();
      for (const file of files(clip)) expect(existsSync(join(dir, file)), file).toBe(true);
    }
  });

  it("keeps each clip small", () => {
    for (const [clip, size] of Object.entries(CLIP_SIZES)) {
      expect(size.width).toBeLessThanOrEqual(720);
      for (const file of files(clip)) expect(statSync(join(dir, file)).size, file).toBeLessThanOrEqual(260 * 1024);
    }
  });

  it("leaves nothing in public/onboarding that nothing shows", () => {
    const names = readdirSync(dir).map((f) => f.replace(/-(dark|light)\.(mp4|webm|webp)$/, ""));
    expect(new Set(names)).toEqual(new Set(Object.keys(CLIP_SIZES)));
    expect(new Set(Object.keys(CLIP_SIZES))).toEqual(used);
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
