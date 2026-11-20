import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { calendarHref, EntryJson, type CalendarEntry } from "./calendar";
import { addDays, CalendarDay } from "./calendar-time";

// A member's calendar feed: an .ics address Google Calendar, Apple Calendar or Outlook polls,
// with no session. The address carries a secret; the database keeps only its sha256
// (calendar_feeds in db/migrations/0030_calendar_repeats.sql).

export const FeedToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "not a feed token");
export type FeedToken = z.infer<typeof FeedToken>;

export function newFeedToken(): { token: FeedToken; hash: string } {
  const token = FeedToken.parse(randomBytes(32).toString("base64url"));
  return { token, hash: feedTokenHash(token) };
}

export function feedTokenHash(token: FeedToken): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function feedPath(token: FeedToken): string {
  return `/api/calendar/feed/${token}.ics`;
}

// The token from the last part of a feed's path, with or without ".ics".
export function tokenFromPath(part: string): FeedToken | null {
  const parsed = FeedToken.safeParse(part.replace(/\.ics$/, ""));
  return parsed.success ? parsed.data : null;
}

// calendar_feed(): null once the address stopped working.
export const FeedJson = z.object({ lab: z.string(), entries: z.array(EntryJson) }).nullable();


// RFC 5545 text: backslash, semicolon, comma and newlines escaped.
export function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

// Lines fold at 75 octets, never inside a character, continuing with a space.
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, "utf8");
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function utcStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function dateValue(day: CalendarDay): string {
  return day.replace(/-/g, "");
}

// A trigger before the start. All-day reminders count from 9 am on the first day, so the
// alarm sits that many minutes after midnight, as calendar_due_reminders has it.
function trigger(minutesBefore: number, allDay: boolean): string {
  const offset = allDay ? 540 - minutesBefore : -minutesBefore;
  const sign = offset < 0 ? "-" : "";
  const abs = Math.abs(offset);
  const days = Math.floor(abs / 1440);
  const hours = Math.floor((abs % 1440) / 60);
  const minutes = abs % 60;
  const time = hours === 0 && minutes === 0 ? "" : `T${hours > 0 ? `${hours}H` : ""}${minutes > 0 ? `${minutes}M` : ""}`;
  return `${sign}P${days > 0 ? `${days}D` : ""}${time || (days > 0 ? "" : "T0M")}`;
}

function description(entry: CalendarEntry, link: string): string {
  const lines = [
    entry.notes,
    entry.experiment === null ? null : `Experiment: ${entry.experiment.name}`,
    entry.protocol === null ? null : `Protocol: ${entry.protocol.title}`,
    entry.people.length === 0 ? null : `People: ${entry.people.map((p) => p.name).join(", ")}`,
    `Open in Binary: ${link}`,
  ];
  return lines.filter((l): l is string => l !== null && l !== "").join("\n\n");
}

export function feedIcs(feed: { lab: string; entries: readonly CalendarEntry[]; origin: string; now: Date }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Binary//Lab calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(`${feed.lab} (Binary)`)}`,
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];
  const stamp = utcStamp(feed.now.toISOString());
  for (const entry of feed.entries) {
    const when = entry.when;
    // The feed doesn't know the reader's zone, so a timed entry links to its day in UTC.
    const day = when.kind === "allDay" ? when.first : CalendarDay.parse(new Date(when.start).toISOString().slice(0, 10));
    const link = `${feed.origin}${calendarHref({ day, entry: entry.id })}`;
    lines.push("BEGIN:VEVENT", `UID:${entry.id}@binary`, `DTSTAMP:${stamp}`, `LAST-MODIFIED:${utcStamp(entry.updatedAt)}`);
    if (when.kind === "allDay") {
      lines.push(`DTSTART;VALUE=DATE:${dateValue(when.first)}`, `DTEND;VALUE=DATE:${dateValue(addDays(when.last, 1))}`);
    } else {
      lines.push(`DTSTART:${utcStamp(when.start)}`, `DTEND:${utcStamp(when.end)}`);
    }
    lines.push(`SUMMARY:${icsText(entry.title)}`, `DESCRIPTION:${icsText(description(entry, link))}`, `URL:${link}`);
    if (entry.instrument !== null) lines.push(`LOCATION:${icsText(entry.instrument.name)}`);
    for (const minutes of entry.reminders) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(entry.title)}`, `TRIGGER:${trigger(minutes, when.kind === "allDay")}`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
