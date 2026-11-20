import { describe, expect, it } from "vitest";
import { PersonId, Sha256 } from "../ids";
import { attestState, CauseRequest, confirmArgs, failureFailure, FailureTypeRequest, type ConfirmerChoice } from "../run-failure";

const priya = PersonId.parse("6f1c2c39-5a4e-4c55-9d7b-0c3c1a7af002");
const ade = PersonId.parse("6f1c2c39-5a4e-4c55-9d7b-0c3c1a7af001");
const file = Sha256.parse(`a${"0".repeat(63)}`);
const choices: ConfirmerChoice[] = [
  { id: ade, name: "Ade", you: false, account: false },
  { id: priya, name: "Priya", you: true, account: true },
];

describe("what the browser sends", () => {
  it("ties the evidence to its method, so a control has a file and the PI's opinion has none", () => {
    const confirm = (evidence: unknown) => CauseRequest.safeParse({ action: "confirm", confirm: { cause: "Old buffer", personId: priya, evidence, note: null, confirmedAt: null } }).success;
    expect(confirm({ method: "control", sha256: file })).toBe(true);
    expect(confirm({ method: "control" })).toBe(false);
    expect(confirm({ method: "repeat", runId: null })).toBe(true);
    expect(confirm({ method: "pi_opinion" })).toBe(true);
    expect(confirm({ method: "guess" })).toBe(false);
  });

  it("refuses a blank cause and keeps failure-type codes in their own place", () => {
    expect(CauseRequest.safeParse({ action: "confirm", confirm: { cause: "  ", personId: priya, evidence: { method: "pi_opinion" }, note: null, confirmedAt: null } }).success).toBe(false);
    expect(FailureTypeRequest.safeParse({ type: { version: 1, technique: "step.setup", failedStep: null, causeCategory: null } }).success).toBe(false);
    expect(FailureTypeRequest.safeParse({ type: null }).success).toBe(true);
  });

  it("names confirm_cause's arguments, sending only the evidence the method takes", () => {
    expect(confirmArgs({ cause: "Old buffer", personId: priya, evidence: { method: "control", sha256: file }, note: "", confirmedAt: null })).toEqual({
      p_cause: "Old buffer",
      p_person_id: priya,
      p_method: "control",
      p_note: null,
      p_confirmed_at: null,
      p_confirm_run: null,
      p_confirm_sha256: file,
    });
    expect(confirmArgs({ cause: "x", personId: priya, evidence: { method: "pi_opinion" }, note: "n", confirmedAt: "2026-11-01T12:00:00Z" })).toMatchObject({
      p_confirm_run: null,
      p_confirm_sha256: null,
      p_note: "n",
    });
  });
});

describe("the confirmer's yes", () => {
  const confirmed = (id: PersonId, attested: string | null) => ({ confirmedBy: { id, name: id === priya ? "Priya" : "Ade" }, confirmerAttestedAt: attested });

  it("asks only the named confirmer, and says why anyone else waits", () => {
    expect(attestState(confirmed(priya, null), choices)).toEqual({ kind: "yours" });
    expect(attestState(confirmed(ade, null), choices)).toEqual({ kind: "no_account", personId: ade, name: "Ade", claimable: false });
    expect(attestState(confirmed(ade, null), choices.map((c) => ({ ...c, you: false })))).toEqual({ kind: "no_account", personId: ade, name: "Ade", claimable: true });
    expect(attestState(confirmed(ade, null), [{ ...choices[0], account: true }])).toEqual({ kind: "waiting", name: "Ade" });
    expect(attestState(confirmed(priya, "2026-11-12T10:00:00Z"), choices)).toEqual({ kind: "attested", at: "2026-11-12T10:00:00Z" });
    expect(attestState({ confirmedBy: null, confirmerAttestedAt: null }, choices)).toBeNull();
  });
});

describe("failure errors", () => {
  it("has its own words for BL91x and falls back to the run record's", () => {
    expect(failureFailure({ code: "BL913" }).message).toBe("A cause goes on a run that failed or was odd. Mark it Failed or Odd first.");
    expect(failureFailure({ code: "BL912" }).status).toBe(403);
    expect(failureFailure({ code: "BL907" }).status).toBe(404);
    expect(failureFailure({}).status).toBe(500);
    expect(failureFailure({ code: "BL983" })).toEqual({ status: 409, message: "That account is already linked to someone else in People. Unlink that first." });
  });
});
