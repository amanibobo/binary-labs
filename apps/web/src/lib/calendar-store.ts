import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CalendarEntryId,
  DAY_FILES_PAGE,
  DayEventRows,
  DayFileRows,
  EntryJson,
  EntryJsonRows,
  entryColumns,
  FILE_KINDS_ON_RECORD,
  filterArgs,
  RecordRows,
  type CalendarEntry,
  type CalendarFilters,
  type CreateEntryRequest,
  type DayResponse,
  type EntryDraft,
  type EntrySaveOutcome,
  type RangeResponse,
  type RecordGroup,
  type RecordKind,
} from "./calendar";
import { ruleArg, type ChangeScope, type RepeatRule } from "./calendar-repeat";
import type { CalendarDay, DayRange } from "./calendar-time";
import { yearActivity, yearChunks, type YearResponse } from "./calendar-year";
import type { FileHit } from "./domain";
import { FolderFilesRows } from "./folders";
import type { InstrumentId, LabId, ProtocolId } from "./ids";
import { logError } from "./log";
import { unwrap, type Supabase } from "./supabase/server";

// The calendar routes' core. Everything goes through the member's session, so RLS decides what
// a lab sees; the database works out the record and checks every link.

export const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_+\-/]+$/, "expected a time zone name");

function rangeArgs(labId: LabId, range: DayRange, timeZone: string, filters: CalendarFilters) {
  return { p_lab_id: labId, p_from: range.first, p_to: range.last, p_tz: timeZone, ...filterArgs(filters) };
}

export async function loadRange(
  supabase: Supabase,
  labId: LabId,
  range: DayRange,
  timeZone: string,
  filters: CalendarFilters,
): Promise<RangeResponse> {
  const args = rangeArgs(labId, range, timeZone, filters);
  const [record, plans] = await Promise.all([supabase.rpc("calendar_record", args), supabase.rpc("calendar_plans", args)]);
  return { record: RecordRows.parse(unwrap(record)), plans: EntryJsonRows.parse(unwrap(plans)) };
}

// The year view's marks: the same reads as a month, two months at a time, counted per day.
export async function loadYear(supabase: Supabase, labId: LabId, year: number, timeZone: string, filters: CalendarFilters): Promise<YearResponse> {
  const parts = await Promise.all(yearChunks(year).map((range) => loadRange(supabase, labId, range, timeZone, filters)));
  return { days: yearActivity({ year, timeZone, record: parts.flatMap((p) => p.record), plans: parts.flatMap((p) => p.plans) }) };
}

// The files of one group on one day, a page at a time, as search shows them.
export async function loadDayFiles(
  supabase: Supabase,
  labId: LabId,
  at: { day: CalendarDay; timeZone: string; filters: CalendarFilters; kind: RecordKind; groupId: string | null },
  page: { offset: number; limit: number },
): Promise<FileHit[]> {
  const base = supabase
    .rpc("calendar_files", rangeArgs(labId, { first: at.day, last: at.day }, at.timeZone, at.filters))
    .select("sha256, kind, group_id, name")
    .eq("kind", at.kind);
  const grouped = at.groupId === null ? base.is("group_id", null) : base.eq("group_id", at.groupId);
  const rows = DayFileRows.parse(
    unwrap(
      await grouped
        .order("name", { ascending: true })
        .order("sha256")
        .range(page.offset, page.offset + page.limit - 1),
    ),
  );
  if (rows.length === 0) return [];
  const shas = rows.map((r) => r.sha256);
  const hits = FolderFilesRows.parse(unwrap(await supabase.rpc("file_hits", { p_lab_id: labId, p_shas: shas })));
  const bySha = new Map<string, FileHit>(hits.map((h) => [h.sha256, h]));
  return shas.flatMap((sha) => {
    const hit = bySha.get(sha);
    return hit === undefined ? [] : [hit];
  });
}

export async function loadDay(
  supabase: Supabase,
  labId: LabId,
  at: { day: CalendarDay; timeZone: string; filters: CalendarFilters },
): Promise<DayResponse> {
  const args = rangeArgs(labId, { first: at.day, last: at.day }, at.timeZone, at.filters);
  const [recordResult, eventsResult] = await Promise.all([
    supabase.rpc("calendar_record", args),
    supabase.rpc("calendar_events", args).select("kind, target, title, at, actor").order("at", { ascending: true }),
  ]);
  const record = RecordRows.parse(unwrap(recordResult));
  const fileGroups = record.filter((g: RecordGroup) => FILE_KINDS_ON_RECORD.has(g.kind));
  const files = await Promise.all(
    fileGroups.map(async (g) => ({
      kind: g.kind,
      groupId: g.groupId,
      hits: await loadDayFiles(supabase, labId, { ...at, kind: g.kind, groupId: g.groupId }, { offset: 0, limit: DAY_FILES_PAGE }),
    })),
  );
  return { record, events: DayEventRows.parse(unwrap(eventsResult)), files };
}

export async function loadEntry(supabase: Supabase, id: CalendarEntryId): Promise<CalendarEntry | null> {
  const json = unwrap(await supabase.rpc("calendar_entry", { p_entry_id: id }));
  return json === null ? null : EntryJson.parse(json);
}

// A protocol's coming plans, for "On the calendar" on its page; `more` when there are others.
export const UPCOMING_LIMIT = 5;

export async function loadUpcoming(supabase: Supabase, labId: LabId, protocolId: ProtocolId): Promise<{ entries: CalendarEntry[]; more: boolean }> {
  const rows = EntryJsonRows.parse(
    unwrap(await supabase.rpc("calendar_upcoming", { p_lab_id: labId, p_protocol_id: protocolId, p_limit: UPCOMING_LIMIT })),
  );
  return { entries: rows.slice(0, UPCOMING_LIMIT), more: rows.length > UPCOMING_LIMIT };
}

export async function loadOverlaps(
  supabase: Supabase,
  labId: LabId,
  q: { instrumentId: InstrumentId; from: string; to: string; timeZone: string; except: CalendarEntryId | null },
): Promise<CalendarEntry[]> {
  return EntryJsonRows.parse(
    unwrap(
      await supabase.rpc("calendar_overlaps", {
        p_lab_id: labId,
        p_instrument_id: q.instrumentId,
        p_from: q.from,
        p_to: q.to,
        p_tz: q.timeZone,
        p_except: q.except,
      }),
    ),
  );
}

type DbError = { code?: string; message: string };
type Written = { kind: "ok"; entry: CalendarEntry } | { kind: "error"; error: DbError };

const IdRows = z.array(z.object({ id: z.string() }));

export async function createEntry(supabase: Supabase, labId: LabId, req: CreateEntryRequest): Promise<Written> {
  const rejoin = req.rejoin === null ? {} : { series_id: req.rejoin.seriesId, occurrence_on: req.rejoin.occurrenceOn };
  const { data, error } = await supabase
    .from("calendar_entries")
    .insert({ lab_id: labId, ...entryColumns(req.draft), ...rejoin })
    .select("id");
  if (error !== null) return { kind: "error", error };
  const [row] = IdRows.parse(data);
  const entry = row === undefined ? null : await loadEntry(supabase, CalendarEntryId.parse(row.id));
  if (entry === null) return { kind: "error", error: { message: "the new entry wasn't readable" } };
  if (req.repeat === null) return { kind: "ok", entry };
  const repeated = await setRepeat(supabase, entry.id, { rule: req.repeat, basedOn: entry.updatedAt, timeZone: req.timeZone });
  // A repeat the database refuses takes the new entry back with it, so a failed create leaves nothing.
  if (repeated.kind === "error") {
    await supabase.from("calendar_entries").delete().eq("lab_id", labId).eq("id", entry.id);
    return repeated;
  }
  return { kind: "ok", entry: repeated.outcome.entry ?? entry };
}

const SaveOutcomeJson = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("saved"), entry: EntryJson }),
  z.object({ kind: z.literal("stale"), entry: EntryJson.nullable() }),
]);

type Outcome = { kind: "outcome"; outcome: EntrySaveOutcome } | { kind: "error"; error: DbError };

// How the entry repeats from here on, or null to stop. calendar_repeat makes the occurrences.
export async function setRepeat(
  supabase: Supabase,
  id: CalendarEntryId,
  req: { rule: RepeatRule | null; basedOn: string; timeZone: string },
): Promise<Outcome> {
  const { data, error } = await supabase.rpc("calendar_repeat", {
    p_entry_id: id,
    p_based_on: req.basedOn,
    p_rule: req.rule === null ? null : ruleArg(req.rule),
    p_tz: req.timeZone,
  });
  if (error !== null) return { kind: "error", error };
  return { kind: "outcome", outcome: SaveOutcomeJson.parse(data) };
}

// Saves over the entry unless someone saved it since the editor loaded it. "all" spreads the
// change to every occurrence of its series.
export async function saveEntry(
  supabase: Supabase,
  labId: LabId,
  id: CalendarEntryId,
  req: { draft: EntryDraft; basedOn: string; scope: ChangeScope },
): Promise<Outcome> {
  if (req.scope === "all") {
    const { data, error } = await supabase.rpc("calendar_save_series", {
      p_entry_id: id,
      p_based_on: req.basedOn,
      p_draft: entryColumns(req.draft),
    });
    if (error !== null) return { kind: "error", error };
    return { kind: "outcome", outcome: SaveOutcomeJson.parse(data) };
  }
  const { data, error } = await supabase
    .from("calendar_entries")
    .update(entryColumns(req.draft))
    .eq("lab_id", labId)
    .eq("id", id)
    .eq("updated_at", req.basedOn)
    .select("id");
  if (error !== null) return { kind: "error", error };
  const entry = await loadEntry(supabase, id);
  if (IdRows.parse(data).length === 0 || entry === null) return { kind: "outcome", outcome: { kind: "stale", entry } };
  return { kind: "outcome", outcome: { kind: "saved", entry } };
}

export async function deleteEntry(
  supabase: Supabase,
  labId: LabId,
  id: CalendarEntryId,
  scope: ChangeScope,
): Promise<{ kind: "ok" } | { kind: "error"; error: DbError }> {
  const { error } =
    scope === "all"
      ? await supabase.rpc("calendar_delete_series", { p_entry_id: id })
      : await supabase.from("calendar_entries").delete().eq("lab_id", labId).eq("id", id);
  return error === null ? { kind: "ok" } : { kind: "error", error };
}

// The caller's reminders on the entry, or on all of its series.
export async function setReminders(
  supabase: Supabase,
  id: CalendarEntryId,
  req: { minutes: number[]; scope: ChangeScope },
): Promise<{ kind: "ok"; entry: CalendarEntry | null } | { kind: "error"; error: DbError }> {
  const { data, error } = await supabase.rpc("calendar_set_reminders", { p_entry_id: id, p_minutes: req.minutes, p_all: req.scope === "all" });
  if (error !== null) return { kind: "error", error };
  return { kind: "ok", entry: data === null ? null : EntryJson.parse(data) };
}

export const DueReminderRows = z.array(z.object({ entry: EntryJson, minutes: z.number().int(), at: z.string() }));

export async function loadDueReminders(supabase: Supabase, labId: LabId, timeZone: string) {
  return DueReminderRows.parse(unwrap(await supabase.rpc("calendar_due_reminders", { p_lab_id: labId, p_tz: timeZone })));
}

export async function markReminderShown(supabase: Supabase, q: { entryId: CalendarEntryId; minutes: number; at: string }) {
  unwrap(await supabase.rpc("calendar_reminder_shown", { p_entry_id: q.entryId, p_minutes: q.minutes, p_at: q.at }));
}

const NO_STORE = { "cache-control": "private, no-store" };

// A database refusal as the browser should see it.
export function entryError(error: DbError, ctx: { event: string; labId: LabId }, fallback = "We couldn't save that entry. Try again."): NextResponse {
  const known: Record<string, [number, string]> = {
    "42501": [403, "You're not a member of this lab."],
    BL401: [404, "That isn't in this lab any more. Pick another, or none."],
    BL103: [404, "That protocol isn't in this lab."],
    BL102: [409, "That protocol is archived. Pick another, or none."],
    BL402: [409, "That instrument was removed. Pick another, or none."],
    BL403: [400, "A repeat can run for up to a year. Pick an earlier end."],
    "23505": [409, "That day already has this entry."],
    "23514": [400, "Check the entry's dates and title."],
    "22023": [400, "Check the dates and the time zone."],
  };
  const hit = error.code === undefined ? undefined : known[error.code];
  if (hit === undefined) {
    logError(ctx.event, { labId: ctx.labId, error });
    return NextResponse.json({ error: fallback }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ error: hit[1] }, { status: hit[0], headers: NO_STORE });
}

// A failed read: unwrap() puts the database's code at the end of its message.
export function readError(error: unknown, ctx: { event: string; labId: LabId }): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  const code = /\(([0-9A-Z]{5})\)$/.exec(message)?.[1];
  return entryError({ message, code }, ctx, "We couldn't load the calendar. Try again.");
}
