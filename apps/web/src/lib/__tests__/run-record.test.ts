import { describe, expect, it } from "vitest";
import { createFixtureRuns, FIRST_TRY, fixtureRuns, RETRY, UNMARKED } from "@/fixtures/runs";
import { Sha256 } from "../ids";
import {
  CreateRunRequest,
  fieldArgs,
  fileSaysLine,
  fileStateLine,
  filterArgs,
  RunJson,
  runFailure,
  RunListFilter,
  RunRecord,
  SetStatusRequest,
  STATUS_CHOICES,
  statusLabel,
} from "../run-record";

const sha = (c: string) => Sha256.parse(c.repeat(64));
const signal = new AbortController().signal;

describe("a run from the database", () => {
  it("reads run_json's snake_case into the app's shape, nested fields too", () => {
    const run = RunJson.parse({
      id: "7d1c2c39-5a4e-4c55-9d7b-0c3c1a7d0001",
      title: "Plate 1",
      started_on: "2026-11-02",
      ended_on: null,
      experiment: null,
      person: { id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7af002", name: "Priya" },
      status: "failed",
      status_by: null,
      status_at: "2026-11-02T10:00:00+00:00",
      created_by: null,
      created_at: "2026-11-02T10:00:00+00:00",
      updated_at: "2026-11-02T10:00:00+00:00",
      retry_of: { id: "7d1c2c39-5a4e-4c55-9d7b-0c3c1a7d0002", title: "Earlier", started_on: null, status: null },
      retried_in: [],
      retry_hint: null,
      files: [{ sha256: sha("a"), role: "shared_control", name: "Plate", original_name: "p.csv", file_kind: "spreadsheet", size: 10, location_id: null, kept: true, file_says: "failed" }],
      failure: { ...fixtureRuns[0]?.failure, suspected_cause: "old buffer", confirm_method: null },
      debrief: { aim: null, expected_seen: "a band", how_found: null, what_changed: null, fix_worked: "not_sure", who_else: null, debriefed_at: null },
      plan: { planned: null, as_run: null },
      share: false,
    });
    expect(run).toMatchObject({ startedOn: "2026-11-02", retryOf: { startedOn: null }, files: [{ originalName: "p.csv", fileSays: "failed", locationId: null }] });
    expect(run.failure.suspectedCause).toBe("old buffer");
    expect(run.debrief).toMatchObject({ expectedSeen: "a band", fixWorked: "not_sure" });
  });

  it("refuses a status the app doesn't know", () => {
    expect(RunRecord.safeParse({ ...fixtureRuns[0], status: "unclear" }).success).toBe(false);
  });
});

describe("what the browser sends", () => {
  it("names only the fields given, so a key left out is left alone and null clears", () => {
    expect(fieldArgs({})).toEqual({});
    expect(fieldArgs({ title: "Plate 2", startedOn: null, status: "odd" })).toEqual({ title: "Plate 2", started_on: null, status: "odd" });
    expect(filterArgs(RunListFilter.parse({ status: "none", experimentId: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7ae001" }))).toEqual({ status: "none", experiment_id: "6f1c2c39-5a4e-4c55-9d7b-0c3c1a7ae001" });
  });

  it("needs 1 to 50 files, a name that isn't blank, and a status that exists", () => {
    expect(CreateRunRequest.safeParse({ shas: [] }).success).toBe(false);
    expect(CreateRunRequest.safeParse({ shas: Array.from({ length: 51 }, () => sha("a")) }).success).toBe(false);
    expect(CreateRunRequest.safeParse({ shas: [sha("a")], fields: { title: "   " } }).success).toBe(false);
    expect(CreateRunRequest.parse({ shas: [sha("a")] }).fields).toEqual({});
    expect(SetStatusRequest.safeParse({ status: "unclear" }).success).toBe(false);
    expect(SetStatusRequest.parse({ status: null })).toEqual({ status: null, clearCauses: false });
  });

  it("turns each database refusal into words a student can act on", () => {
    expect(runFailure({ code: "BL902" })).toEqual({ status: 400, message: "A run keeps at least one file. Add another before taking this one out." });
    expect(runFailure({ code: "42501" }).status).toBe(403);
    expect(runFailure({ code: "BL907" }).status).toBe(404);
    expect(runFailure({ code: "XX000" }).status).toBe(500);
    expect(runFailure({}).status).toBe(500);
  });
});

describe("the run page's words", () => {
  it("explains each answer in a line, odd included", () => {
    expect(STATUS_CHOICES.map((c) => c.label)).toEqual(["Worked", "Failed", "Odd"]);
    for (const c of STATUS_CHOICES) expect(c.hint.length).toBeGreaterThan(10);
    expect(statusLabel(null)).toBe("Not marked yet");
    expect(statusLabel("odd")).toBe("Odd");
  });

  it("says when a file's copy isn't kept yet, or the file has left the lab", () => {
    expect(fileStateLine({ kept: true, locationId: null })).toBe("Removed from the lab's folder. The run keeps its copy.");
    expect(fileStateLine({ kept: false, locationId: null })).toBe("Binary is still saving its copy of this file.");
    const live = fixtureRuns.find((r) => r.id === FIRST_TRY)?.files[0];
    expect(live === undefined ? "missing" : fileStateLine(live)).toBeNull();
  });

  it("shows the label's outcome only as a hint, and only when it differs from the run", () => {
    expect(fileSaysLine({ fileSays: "failed" }, "failed")).toBeNull();
    expect(fileSaysLine({ fileSays: null }, "failed")).toBeNull();
    expect(fileSaysLine({ fileSays: "failed" }, "worked")).toBe("The file's label says failed.");
    expect(fileSaysLine({ fileSays: "repeat" }, null)).toBe("The file's label says a repeat.");
  });
});

// The fixture twin must behave as the database does where the screens depend on it.
describe("the fixture run record", () => {
  it("makes a run from picked files, read once from the first file", async () => {
    const api = createFixtureRuns();
    const first = fixtureRuns.find((r) => r.id === RETRY)?.files[0];
    if (first === undefined) throw new Error("the fixture has no file");
    const run = await api.create([first.sha256], {});
    expect(run).toMatchObject({ title: first.name, statusBy: null, share: false, files: [{ sha256: first.sha256, role: "evidence" }] });
    expect((await api.list({ filter: {}, offset: 0 }, signal)).map((r) => r.id)).toContain(run.id);
    expect((await api.fileRuns([first.sha256], signal))[0]?.sha256).toBe(first.sha256);
  });

  it("asks before a status change removes a cause, links retries both ways and keeps one file", async () => {
    const api = createFixtureRuns();
    expect((await api.setStatus(UNMARKED, "odd", false)).kind).toBe("saved");
    const linked = await api.linkRetry(UNMARKED, FIRST_TRY);
    expect(linked.retryOf?.id).toBe(FIRST_TRY);
    expect((await api.run(FIRST_TRY, signal)).retriedIn.map((r) => r.id)).toContain(UNMARKED);
    expect((await api.linkRetry(UNMARKED, null)).retryOf).toBeNull();
    expect((await api.run(FIRST_TRY, signal)).retriedIn.map((r) => r.id)).not.toContain(UNMARKED);

    const retry = await api.run(RETRY, signal);
    const [a, b] = retry.files;
    if (a === undefined || b === undefined) throw new Error("the retry fixture has two files");
    expect((await api.removeFile(RETRY, a.sha256)).files.map((f) => f.sha256)).toEqual([b.sha256]);
    await expect(api.removeFile(RETRY, b.sha256)).rejects.toThrow("A run keeps at least one file");
  });
});
