"use client";

import { createContext, use } from "react";
import { z } from "zod";
import {
  DayFilesResponse,
  DayResponse,
  DueRemindersResponse,
  EntrySaveOutcomeWire,
  FeedStatus,
  NewFeed,
  EntryWire,
  filterQuery,
  RangeResponse,
  type CalendarEntry,
  type CalendarEntryId,
  type CalendarFilters,
  type CreateEntryRequest,
  type DayResponse as Day,
  type DueReminder,
  type FeedStatus as Feed,
  type EntryDraft,
  type EntrySaveOutcome,
  type RangeResponse as Range,
  type RecordKind,
} from "@/lib/calendar";
import type { ChangeScope, RepeatRule } from "@/lib/calendar-repeat";
import type { CalendarDay, DayRange } from "@/lib/calendar-time";
import { YearResponse, type DayActivity } from "@/lib/calendar-year";
import type { FileHit } from "@/lib/domain";
import type { InstrumentId } from "@/lib/ids";

// What the calendar fetches. Its own context, beside LabApi, so the fixture pages can swap in
// canned data without touching the rest of the app's API.
export type CalendarApi = {
  range: (q: { range: DayRange; timeZone: string; filters: CalendarFilters }, signal: AbortSignal) => Promise<Range>;
  year: (q: { year: number; timeZone: string; filters: CalendarFilters }, signal: AbortSignal) => Promise<DayActivity[]>;
  day: (q: { day: CalendarDay; timeZone: string; filters: CalendarFilters }, signal: AbortSignal) => Promise<Day>;
  dayFiles: (
    q: { day: CalendarDay; timeZone: string; filters: CalendarFilters; kind: RecordKind; groupId: string | null; offset: number },
    signal: AbortSignal,
  ) => Promise<FileHit[]>;
  overlaps: (
    q: { instrumentId: InstrumentId; from: string; to: string; timeZone: string; except: CalendarEntryId | null },
    signal: AbortSignal,
  ) => Promise<CalendarEntry[]>;
  // These reject with an Error whose message can be shown; a stale save resolves as { kind: "stale" }.
  createEntry: (req: CreateEntryRequest) => Promise<CalendarEntry>;
  saveEntry: (id: CalendarEntryId, draft: EntryDraft, basedOn: string, scope: ChangeScope) => Promise<EntrySaveOutcome>;
  setRepeat: (id: CalendarEntryId, rule: RepeatRule | null, basedOn: string, timeZone: string) => Promise<EntrySaveOutcome>;
  setReminders: (id: CalendarEntryId, minutes: number[], scope: ChangeScope) => Promise<CalendarEntry>;
  deleteEntry: (id: CalendarEntryId, scope: ChangeScope) => Promise<void>;
  dueReminders: (timeZone: string, signal: AbortSignal) => Promise<DueReminder[]>;
  reminderShown: (shown: { entryId: CalendarEntryId; minutes: number; at: string }) => Promise<void>;
  feedStatus: (signal: AbortSignal) => Promise<Feed>;
  // A new feed address, shown once; the old one stops working.
  resetFeed: () => Promise<{ url: string; madeAt: string }>;
};

const ErrorBody = z.object({ error: z.string() });

async function getJson(path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

async function send(url: string, method: "POST" | "DELETE", body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function failure(json: unknown): Error {
  const parsed = ErrorBody.safeParse(json);
  return new Error(parsed.success ? parsed.data.error : "We couldn't save that entry. Try again.");
}

function outcomeOf({ status, json }: { status: number; json: unknown }): EntrySaveOutcome {
  if (status !== 200 && status !== 409) throw failure(json);
  const outcome = EntrySaveOutcomeWire.safeParse(json);
  if (!outcome.success) throw failure(json);
  return outcome.data;
}

export const httpCalendarApi: CalendarApi = {
  range: async ({ range, timeZone, filters }, signal) =>
    RangeResponse.parse(await getJson("/api/calendar", { from: range.first, to: range.last, tz: timeZone, ...filterQuery(filters) }, signal)),
  year: async ({ year, timeZone, filters }, signal) =>
    YearResponse.parse(await getJson("/api/calendar/year", { year: String(year), tz: timeZone, ...filterQuery(filters) }, signal)).days,
  day: async ({ day, timeZone, filters }, signal) =>
    DayResponse.parse(await getJson("/api/calendar/day", { day, tz: timeZone, ...filterQuery(filters) }, signal)),
  dayFiles: async ({ day, timeZone, filters, kind, groupId, offset }, signal) =>
    DayFilesResponse.parse(
      await getJson(
        "/api/calendar/files",
        { day, tz: timeZone, kind, offset: String(offset), ...(groupId === null ? {} : { group: groupId }), ...filterQuery(filters) },
        signal,
      ),
    ).files,
  overlaps: async ({ instrumentId, from, to, timeZone, except }, signal) =>
    z
      .object({ entries: z.array(EntryWire) })
      .parse(
        await getJson("/api/calendar/overlaps", { instrument: instrumentId, from, to, tz: timeZone, ...(except === null ? {} : { except }) }, signal),
      ).entries,
  createEntry: async (req) => {
    const { status, json } = await send("/api/calendar/entries", "POST", req);
    if (status !== 200) throw failure(json);
    return EntryWire.parse(json);
  },
  saveEntry: async (id, draft, basedOn, scope) => outcomeOf(await send(`/api/calendar/entries/${id}`, "POST", { draft, basedOn, scope })),
  setRepeat: async (id, rule, basedOn, timeZone) =>
    outcomeOf(await send(`/api/calendar/entries/${id}/repeat`, "POST", { rule, basedOn, timeZone })),
  setReminders: async (id, minutes, scope) => {
    const { status, json } = await send(`/api/calendar/entries/${id}/reminders`, "POST", { minutes, scope });
    if (status !== 200) throw failure(json);
    return EntryWire.parse(json);
  },
  deleteEntry: async (id, scope) => {
    const { status, json } = await send(`/api/calendar/entries/${id}`, "DELETE", { scope });
    if (status !== 200) throw failure(json);
  },
  dueReminders: async (timeZone, signal) => DueRemindersResponse.parse(await getJson("/api/calendar/reminders", { tz: timeZone }, signal)).due,
  reminderShown: async (shown) => {
    await send("/api/calendar/reminders", "POST", shown);
  },
  feedStatus: async (signal) => FeedStatus.parse(await getJson("/api/calendar/feed", {}, signal)),
  resetFeed: async () => {
    const { status, json } = await send("/api/calendar/feed", "POST", {});
    if (status !== 200) throw failure(json);
    return NewFeed.parse(json);
  },
};

const CalendarApiContext = createContext<CalendarApi>(httpCalendarApi);
export const CalendarApiProvider = CalendarApiContext.Provider;

export function useCalendarApi(): CalendarApi {
  return use(CalendarApiContext);
}
