import { describe, expect, it } from "vitest";
import { EntryWire, type CalendarEntry } from "../calendar";
import { feedIcs, feedPath, feedTokenHash, foldLine, icsText, newFeedToken, tokenFromPath } from "../calendar-feed";

const entry = (fields: Record<string, unknown>): CalendarEntry =>
  EntryWire.parse({
    id: "8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c0001",
    notes: null,
    experiment: null,
    protocol: null,
    instrument: null,
    people: [],
    repeat: null,
    reminders: [],
    createdBy: null,
    createdAt: "2026-11-01T12:00:00Z",
    updatedAt: "2026-11-02T12:30:00Z",
    ...fields,
  });

const unfold = (ics: string) => ics.replace(/\r\n /g, "");
const now = new Date("2026-11-19T12:00:00Z");

describe("the calendar feed", () => {
  it("writes a timed entry in UTC and an all-day one as dates, the end the day after", () => {
    const ics = feedIcs({
      lab: "Okafor lab",
      origin: "https://binary.test",
      now,
      entries: [
        entry({
          title: "Plate reader",
          when: { kind: "timed", start: "2026-11-17T15:00:00Z", end: "2026-11-17T16:00:00Z" },
          instrument: { id: "8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c0002", name: "SpectraMax", revoked: false },
          reminders: [15, 1440],
        }),
        entry({ id: "8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c0003", title: "Retreat", when: { kind: "allDay", first: "2026-12-10", last: "2026-12-11" }, reminders: [0, 1440] }),
      ],
    });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    const lines = unfold(ics).split("\r\n");
    expect(lines).toContain("X-WR-CALNAME:Okafor lab (Binary)");
    expect(lines).toContain("UID:8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c0001@binary");
    expect(lines).toContain("DTSTART:20261117T150000Z");
    expect(lines).toContain("DTEND:20261117T160000Z");
    expect(lines).toContain("LOCATION:SpectraMax");
    expect(lines).toContain("LAST-MODIFIED:20261102T123000Z");
    expect(lines.filter((l) => l.startsWith("TRIGGER:"))).toEqual(["TRIGGER:-PT15M", "TRIGGER:-P1D", "TRIGGER:PT9H", "TRIGGER:-PT15H"]);
    expect(lines).toContain("DTSTART;VALUE=DATE:20261210");
    expect(lines).toContain("DTEND;VALUE=DATE:20261212");
    expect(lines).toContain("URL:https://binary.test/calendar?date=2026-11-17&entry=8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c0001");
  });

  it("escapes text and folds long lines without splitting a character", () => {
    expect(icsText("Gel; lanes 1, 2\nthen\\image")).toBe("Gel\\; lanes 1\\, 2\\nthen\\\\image");
    const long = `DESCRIPTION:${"µ".repeat(60)}`;
    const folded = foldLine(long);
    for (const line of folded.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("puts the notes, links and a way back into the description", () => {
    const ics = feedIcs({
      lab: "Lab",
      origin: "https://binary.test",
      now,
      entries: [
        entry({
          title: "Nickel column",
          notes: "Bring the 1% gel",
          when: { kind: "timed", start: "2026-11-17T15:00:00Z", end: "2026-11-17T16:00:00Z" },
          people: [{ id: "8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c0009", name: "Priya" }],
        }),
      ],
    });
    expect(unfold(ics)).toContain("DESCRIPTION:Bring the 1% gel\\n\\nPeople: Priya\\n\\nOpen in Binary: https://binary.test/calendar?date=2026-11-17&entry=");
  });

  it("makes a token that only its own path reads back, and keeps only a hash", () => {
    const { token, hash } = newFeedToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(feedTokenHash(token)).toBe(hash);
    expect(newFeedToken().token).not.toBe(token);
    expect(tokenFromPath(feedPath(token).split("/").at(-1) ?? "")).toBe(token);
    expect(tokenFromPath(token)).toBe(token);
    expect(tokenFromPath("not-a-token.ics")).toBeNull();
  });
});
