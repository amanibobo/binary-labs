import { describe, expect, it, vi } from "vitest";
import { codeFromBytes, displayCode, InstrumentPath, instrumentsLine, LabInstrumentsRows, normalizeCode, seenLine } from "../instruments";

vi.mock("server-only", () => ({}));
const { bearerToken, newPairingCode } = await import("../instrument-upload");

describe("pairing codes", () => {
  it("are eight characters a person can read off one screen and type on another", () => {
    const { code, hash } = newPairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(displayCode("K7QM4XPA")).toBe("K7QM-4XPA");
    expect(codeFromBytes(new Uint8Array([0, 31, 32, 255, 8, 18, 22, 27]))).toBe("0Z0Z8JPV");
  });

  it("are read as typed: any case, spaces, dashes, and O, I or L for 0 and 1", () => {
    expect(normalizeCode(" k7qm-4xpa ")).toBe("K7QM4XPA");
    expect(normalizeCode("O1IL 2345")).toBe("01112345");
    expect(normalizeCode("K7QM4XP")).toBeNull();
    expect(normalizeCode("K7QM4XPU")).toBeNull();
  });
});

describe("the device token header", () => {
  it("takes only a bearer token in the uploader's own format", () => {
    const token = `blu_${"a".repeat(43)}`;
    expect(bearerToken(new Headers({ authorization: `Bearer ${token}` }))).toBe(token);
    expect(bearerToken(new Headers({ authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.x" }))).toBeNull();
    expect(bearerToken(new Headers({ authorization: token }))).toBeNull();
    expect(bearerToken(new Headers({ cookie: `token=${token}` }))).toBeNull();
  });
});

describe("instrument paths", () => {
  it("are folder/name with forward slashes and nothing that climbs out", () => {
    expect(InstrumentPath.safeParse("Exports/P450/plate 07.csv").success).toBe(true);
    for (const bad of ["/Exports/a.csv", "Exports//a.csv", "Exports/../a.csv", "./a.csv", "Exports\\a.csv", "a/", "a\u0000b"]) {
      expect(InstrumentPath.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("what Settings says", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  it("says when the uploader last checked in", () => {
    expect(seenLine(null, now)).toBe("Not seen yet");
    expect(seenLine("2026-11-05T11:59:10Z", now)).toBe("Seen just now");
    expect(seenLine("2026-11-05T11:20:00Z", now)).toBe("Seen 40 minutes ago");
    expect(seenLine("2026-11-05T09:00:00Z", now)).toBe("Seen 3 hours ago");
    expect(seenLine("2026-11-04T09:00:00Z", now)).toBe("Seen yesterday");
  });

  it("counts live instruments and their files on the tile", () => {
    const rows = LabInstrumentsRows.parse([
      { id: "00000000-0000-4000-8000-000000000001", name: "Plate reader", state: "paired", pairing_expires_at: null, paired_at: "2026-11-01T00:00:00Z", last_seen_at: "2026-11-05T11:59:00Z", revoked_at: null, files: 1200 },
      { id: "00000000-0000-4000-8000-000000000002", name: "qPCR", state: "waiting", pairing_expires_at: "2026-11-05T12:10:00Z", paired_at: null, last_seen_at: null, revoked_at: null, files: "0" },
      { id: "00000000-0000-4000-8000-000000000003", name: "Old reader", state: "revoked", pairing_expires_at: null, paired_at: null, last_seen_at: null, revoked_at: "2026-10-01T00:00:00Z", files: 40 },
    ]);
    expect(rows.map((r) => r.state.kind)).toEqual(["paired", "waiting", "revoked"]);
    expect(instrumentsLine(rows)).toBe("2 instruments, 1,200 files");
    expect(instrumentsLine([])).toBe("None yet");
  });
});
