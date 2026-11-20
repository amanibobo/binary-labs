import { describe, expect, it, vi } from "vitest";
import { blockWords, SHARING_AGREEMENT, sharingEvent, sharingLogLine, type SharingLogEntry } from "@/components/runs/api/sharing";
import { createFixtureRuns, FIRST_TRY, RETRY, UNMARKED } from "@/fixtures/runs";
import { UserId } from "../ids";
import { askExportGate } from "../export-gate";
import type { RunDb } from "../run-record-store";
import { sharingFailure } from "../run-sharing-store";

vi.mock("server-only", () => ({}));

const someone = UserId.parse("00000000-0000-4000-8000-00000000000b");
const row = (fields: Partial<SharingLogEntry> & Pick<SharingLogEntry, "action" | "after">) => ({ via: "person" as const, actor: someone, actorName: "Priya Nair", ...fields });

describe("a sharing log row as a sentence", () => {
  it.each([
    [row({ action: "run.share", after: { share: true } }), "Priya Nair turned sharing on for this run."],
    [row({ action: "run.share", after: { share: false } }), "Priya Nair turned sharing off for this run."],
    [row({ action: "run.share", via: "trigger", after: { share: false } }), "Sharing went off for this run because Priya Nair changed the run."],
    [row({ action: "run.share", via: "trigger", after: { share: false }, actor: null, actorName: null }), "Sharing went off for this run because Binary changed the run."],
    [row({ action: "lab.share", after: { agreedAt: "2026-11-05T10:12:00Z", agreement: "draft-1" } }), "Priya Nair agreed to share for the lab (wording draft-1)."],
    [row({ action: "lab.share", after: { agreedAt: null, agreement: null } }), "Priya Nair took back the lab's agreement to share."],
    [row({ action: "export.allowed", after: { purpose: "task folder" } }), "Priya Nair asked to export this run. Allowed."],
    [
      row({ action: "export.blocked", after: { blocks: ["run_off", "lab_off", "not_attested"] } }),
      "Priya Nair asked to export this run. Blocked: this run's sharing is off, the lab hasn't agreed to share and the person named as confirming the cause hasn't said so themselves.",
    ],
    [row({ action: "export.blocked", after: { blocks: ["not_member"] }, actorName: null }), "Someone who isn't in the lab asked to export this run. Blocked."],
    [
      row({ action: "export.blocked", after: { blocks: ["withdrawn"], folders: 2, sentCopies: "cannot be pulled back" } }),
      "2 task folders built from this run withdrawn. Binary removes its copies. Copies already sent to someone else can't be pulled back.",
    ],
  ])("%#", (entry, line) => {
    expect(sharingLogLine(entry, "this run")).toBe(line);
  });

  it("never reads a row it can't parse as an export that was allowed or a switch that went on", () => {
    for (const after of [null, {}, { share: "yes" }, { blocks: "all" }, { blocks: ["a_new_reason"] }]) {
      expect(sharingEvent({ action: "run.share", via: "person", after }).kind).toBe("other");
      expect(sharingEvent({ action: "export.blocked", via: "person", after }).kind).toBe("other");
    }
    expect(blockWords(["demo_lab"])).toBe("this is a demo lab, and its data is made up");
  });
});

describe("the agreement's wording", () => {
  it("is marked as a draft, has a version, and says sent copies can't be pulled back", () => {
    expect(SHARING_AGREEMENT.version).toMatch(/^draft-\d+$/);
    expect(SHARING_AGREEMENT.draftNote).toMatch(/^Draft wording\./);
    expect(SHARING_AGREEMENT.paragraphs.join(" ")).toContain("can't be pulled back");
  });
});

describe("asking the gate", () => {
  const answering = (data: unknown): RunDb => ({ rpc: async () => ({ data, error: null }) });
  const id = FIRST_TRY;

  it("is allowed only by a whole grant", async () => {
    expect(await askExportGate(answering({ allowed: true, blocks: [], grant_id: 7, expires_at: "2026-11-20T11:00:00Z" }), id, "x")).toEqual({ kind: "allowed", grantId: 7, expiresAt: "2026-11-20T11:00:00Z" });
    expect(await askExportGate(answering({ allowed: true, blocks: [], grant_id: null, expires_at: null }), id, "x")).toEqual({ kind: "blocked", blocks: [] });
    expect(await askExportGate(answering({ allowed: true, blocks: ["lab_off"], grant_id: 7, expires_at: "2026-11-20T11:00:00Z" }), id, "x")).toEqual({ kind: "blocked", blocks: ["lab_off"] });
    expect(await askExportGate(answering({ allowed: false, blocks: ["run_off"], grant_id: null, expires_at: null }), id, "x")).toEqual({ kind: "blocked", blocks: ["run_off"] });
  });

  it("throws rather than allow when the database's answer isn't one it knows", async () => {
    await expect(askExportGate(answering(null), id, "x")).rejects.toThrow();
    await expect(askExportGate(answering({ allowed: "yes" }), id, "x")).rejects.toThrow();
    await expect(askExportGate({ rpc: async () => ({ data: null, error: { message: "down" } }) }, id, "x")).rejects.toThrow();
  });
});

describe("what a refused write says", () => {
  it("names who can change it", () => {
    expect(sharingFailure({ code: "BL931" }, "run")).toEqual({ status: 403, message: "Only the person who ran this run, or an admin, can change its sharing." });
    expect(sharingFailure({ code: "42501" }, "lab").message).toBe("Only an admin can do that for the lab.");
    expect(sharingFailure({ code: "BL907" }, "run").status).toBe(404);
    expect(sharingFailure({}, "run").status).toBe(500);
  });
});

describe("the fixture twin", () => {
  const signal = new AbortController().signal;

  it("starts a run off, turns it on for the person who ran it, and refuses someone who didn't", async () => {
    const api = createFixtureRuns();
    expect(await api.runSharing(FIRST_TRY, signal)).toMatchObject({ share: false, canChange: true, blocks: ["run_off"] });
    expect((await api.setRunShare(FIRST_TRY, true)).share).toBe(true);
    expect(await api.runSharing(FIRST_TRY, signal)).toMatchObject({ share: true, blocks: [] });
    expect(await api.runSharing(UNMARKED, signal)).toMatchObject({ canChange: false, blocks: ["not_attested"] });
    await expect(api.setRunShare(UNMARKED, false)).rejects.toThrow("Only the person who ran this run");
  });

  it("withdraws a built folder when its run's sharing goes off, and says so in the log", async () => {
    const api = createFixtureRuns();
    expect(await api.runSharing(RETRY, signal)).toMatchObject({ share: true, built: 1, withdrawn: 0 });
    await api.setRunShare(RETRY, false);
    expect(await api.runSharing(RETRY, signal)).toMatchObject({ share: false, built: 0, withdrawn: 1 });
    const [first] = await api.sharingLog(RETRY, signal);
    expect(first === undefined ? null : sharingLogLine(first, "this run")).toContain("can't be pulled back");
  });

  it("blocks every run once the lab's agreement is taken back", async () => {
    const api = createFixtureRuns();
    expect((await api.setLabShare(false, "")).agreedAt).toBeNull();
    expect((await api.runSharing(RETRY, signal)).blocks).toContain("lab_off");
    expect((await api.setLabShare(true, SHARING_AGREEMENT.version)).agreement).toBe(SHARING_AGREEMENT.version);
  });
});
