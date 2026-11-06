import { z } from "zod";
import { FileHitWire, type FileHit } from "./domain";
import { ChartId, ExperimentId, InstrumentId, PersonId, ProtocolId, TalkThroughId, UserId } from "./ids";
import { CalendarDay, wallClock, type DayRange } from "./calendar-time";
import { countLine } from "./format";

// The lab calendar (docs/decisions.md, "the lab calendar"): plans people write, and the record
// of what happened, worked out per day by calendar_record (db/migrations/0017_calendar.sql).

// calendar_entries.id: one plan on the lab's calendar.
export const CalendarEntryId = z.uuid().brand<"CalendarEntryId">();
export type CalendarEntryId = z.infer<typeof CalendarEntryId>;

const Timestamp = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected a timestamp");

// PostgREST sends bigint as a JSON number, but a numeric string is also a valid encoding.
const Count = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative());

// What the record holds, in the order a day lists them and the series palette's order, so each
// kind keeps one color (--chart-<color> in globals.css, validated as the charts' palette).
export const RECORD_KINDS = ["file", "upload", "instrument", "protocol", "chart", "talk_through"] as const;
export const RecordKind = z.enum(RECORD_KINDS);
export type RecordKind = z.infer<typeof RecordKind>;

export const KIND_COLORS = {
  file: "blue",
  upload: "orange",
  instrument: "aqua",
  protocol: "violet",
  chart: "magenta",
  talk_through: "green",
} as const satisfies Record<RecordKind, string>;

export const KIND_NAMES = {
  file: "Files",
  upload: "Uploads",
  instrument: "Instrument files",
  protocol: "Protocol saves",
  chart: "Charts",
  talk_through: "Talk-throughs",
} as const satisfies Record<RecordKind, string>;

// One line of a day's record: how many of a kind, in one experiment, instrument or protocol.
export type RecordGroup = {
  day: CalendarDay;
  kind: RecordKind;
  groupId: string | null;
  groupName: string | null;
  items: number;
  // The one item's name, when there's one.
  title: string | null;
};

export const RecordRows = z.array(
  z
    .object({
      day: CalendarDay,
      kind: RecordKind,
      group_id: z.uuid().nullable(),
      group_name: z.string().nullable(),
      items: Count,
      title: z.string().nullable(),
    })
    .transform(
      (r): RecordGroup => ({ day: r.day, kind: r.kind, groupId: r.group_id, groupName: r.group_name, items: r.items, title: r.title }),
    ),
);

const RecordGroupWire = z.object({
  day: CalendarDay,
  kind: RecordKind,
  groupId: z.string().nullable(),
  groupName: z.string().nullable(),
  items: z.number(),
  title: z.string().nullable(),
}) satisfies z.ZodType<RecordGroup>;

const NOUNS = {
  file: ["file", "files"],
  upload: ["upload", "uploads"],
  instrument: ["file", "files"],
  chart: ["chart", "charts"],
  talk_through: ["talk-through", "talk-throughs"],
} as const;

// "12 files · P450 BM3", "4 files · SpectraMax", "1 upload · Gel batch 5", "Bradford assay · 2 saves".
export function recordLine(group: RecordGroup): string {
  if (group.kind === "protocol") {
    const name = group.groupName ?? "A protocol";
    return group.items === 1 ? `${name} · saved` : `${name} · ${group.items} saves`;
  }
  const [one, many] = NOUNS[group.kind];
  const count = countLine(group.items, one, many);
  const detail = group.groupName ?? (group.items === 1 ? group.title : null);
  return detail === null ? count : `${count} · ${detail}`;
}

export function groupKey(group: Pick<RecordGroup, "kind" | "groupId">): string {
  return `${group.kind}:${group.groupId ?? ""}`;
}

export const FILE_KINDS_ON_RECORD = new Set<RecordKind>(["file", "upload", "instrument"]);

// When a plan happens: whole days (the last included), or two moments (the end excluded).
export type EntryWhen = { kind: "allDay"; first: CalendarDay; last: CalendarDay } | { kind: "timed"; start: string; end: string };

const EntryWhenWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("allDay"), first: CalendarDay, last: CalendarDay }),
  z.object({ kind: z.literal("timed"), start: Timestamp, end: Timestamp }),
]) satisfies z.ZodType<EntryWhen>;

export type CalendarEntry = {
  id: CalendarEntryId;
  title: string;
  notes: string | null;
  when: EntryWhen;
  experiment: { id: ExperimentId; name: string } | null;
  protocol: { id: ProtocolId; title: string; archived: boolean } | null;
  instrument: { id: InstrumentId; name: string; revoked: boolean } | null;
  people: { id: PersonId; name: string }[];
  createdBy: UserId | null;
  createdAt: string;
  updatedAt: string;
};

const entryLinks = {
  experiment: z.object({ id: ExperimentId, name: z.string() }).nullable(),
  protocol: z.object({ id: ProtocolId, title: z.string(), archived: z.boolean() }).nullable(),
  instrument: z.object({ id: InstrumentId, name: z.string(), revoked: z.boolean() }).nullable(),
  people: z.array(z.object({ id: PersonId, name: z.string() })),
};

// calendar_entry_json() in SQL.
export const EntryJson = z
  .object({
    id: CalendarEntryId,
    title: z.string(),
    notes: z.string().nullable(),
    starts_on: CalendarDay.nullable(),
    ends_on: CalendarDay.nullable(),
    starts_at: Timestamp.nullable(),
    ends_at: Timestamp.nullable(),
    ...entryLinks,
    created_by: UserId.nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .transform((r, ctx): CalendarEntry => {
    let when: EntryWhen;
    if (r.starts_on !== null && r.ends_on !== null) when = { kind: "allDay", first: r.starts_on, last: r.ends_on };
    else if (r.starts_at !== null && r.ends_at !== null) when = { kind: "timed", start: r.starts_at, end: r.ends_at };
    else {
      ctx.addIssue({ code: "custom", message: "an entry needs days or times" });
      return z.NEVER;
    }
    return {
      id: r.id,
      title: r.title,
      notes: r.notes,
      when,
      experiment: r.experiment,
      protocol: r.protocol,
      instrument: r.instrument,
      people: r.people,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
export const EntryJsonRows = z.array(EntryJson);

export const EntryWire = z.object({
  id: CalendarEntryId,
  title: z.string(),
  notes: z.string().nullable(),
  when: EntryWhenWire,
  ...entryLinks,
  createdBy: UserId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) satisfies z.ZodType<CalendarEntry>;

// What the editor writes. The database checks the links stay in the lab.
export const EntryDraft = z
  .object({
    title: z.string().trim().min(1, "Give the entry a title.").max(200, "Keep the title under 200 characters."),
    notes: z.string().max(10_000, "Keep notes under 10,000 characters.").nullable(),
    when: EntryWhenWire,
    experimentId: ExperimentId.nullable(),
    protocolId: ProtocolId.nullable(),
    instrumentId: InstrumentId.nullable(),
    personIds: z.array(PersonId).max(20, "Up to 20 people."),
  })
  .refine(
    (d) => (d.when.kind === "allDay" ? d.when.first <= d.when.last : Date.parse(d.when.end) > Date.parse(d.when.start)),
    "The end comes before the start.",
  );
export type EntryDraft = z.infer<typeof EntryDraft>;

export const SaveEntryRequest = z.object({ draft: EntryDraft, basedOn: Timestamp });
export type SaveEntryRequest = z.infer<typeof SaveEntryRequest>;

export type EntrySaveOutcome = { kind: "saved"; entry: CalendarEntry } | { kind: "stale"; entry: CalendarEntry | null };
export const EntrySaveOutcomeWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("saved"), entry: EntryWire }),
  z.object({ kind: z.literal("stale"), entry: EntryWire.nullable() }),
]) satisfies z.ZodType<EntrySaveOutcome>;

// The columns a draft writes.
export function entryColumns(draft: EntryDraft) {
  return {
    title: draft.title,
    notes: draft.notes,
    starts_on: draft.when.kind === "allDay" ? draft.when.first : null,
    ends_on: draft.when.kind === "allDay" ? draft.when.last : null,
    starts_at: draft.when.kind === "timed" ? draft.when.start : null,
    ends_at: draft.when.kind === "timed" ? draft.when.end : null,
    experiment_id: draft.experimentId,
    protocol_id: draft.protocolId,
    instrument_id: draft.instrumentId,
    person_ids: draft.personIds,
  };
}

export function draftOf(entry: CalendarEntry): EntryDraft {
  return {
    title: entry.title,
    notes: entry.notes,
    when: entry.when,
    experimentId: entry.experiment?.id ?? null,
    protocolId: entry.protocol?.id ?? null,
    instrumentId: entry.instrument?.id ?? null,
    personIds: entry.people.map((p) => p.id),
  };
}

// The days an entry covers where the viewer is. A timed entry ending at midnight ends the day before.
export function entryDays(when: EntryWhen, timeZone: string): DayRange {
  if (when.kind === "allDay") return { first: when.first, last: when.last };
  const first = wallClock(new Date(when.start), timeZone).day;
  const last = wallClock(new Date(Date.parse(when.end) - 1), timeZone).day;
  return { first, last: last < first ? first : last };
}

export const CalendarFilters = z.object({
  experiment: ExperimentId.optional(),
  person: PersonId.optional(),
  instrument: InstrumentId.optional(),
});
export type CalendarFilters = z.infer<typeof CalendarFilters>;

export function filterArgs(filters: CalendarFilters) {
  return {
    p_experiment_id: filters.experiment ?? null,
    p_person_id: filters.person ?? null,
    p_instrument_id: filters.instrument ?? null,
  };
}

export function filterQuery(filters: CalendarFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.experiment !== undefined) out.experiment = filters.experiment;
  if (filters.person !== undefined) out.person = filters.person;
  if (filters.instrument !== undefined) out.instrument = filters.instrument;
  return out;
}

export function hasCalendarFilters(filters: CalendarFilters): boolean {
  return filters.experiment !== undefined || filters.person !== undefined || filters.instrument !== undefined;
}

// A month grid or a week, with what's on it.
export type RangeResponse = { record: RecordGroup[]; plans: CalendarEntry[] };
export const RangeResponse = z.object({ record: z.array(RecordGroupWire), plans: z.array(EntryWire) }) satisfies z.ZodType<RangeResponse>;

// A protocol save, chart or talk-through on a day, each opening where the rest of the app does.
export type DayEvent =
  | { kind: "protocol"; id: ProtocolId; title: string; at: string; actor: UserId | null }
  | { kind: "chart"; id: ChartId; title: string; at: string; actor: UserId | null }
  | { kind: "talk_through"; id: TalkThroughId; title: string; at: string; actor: UserId | null };

const eventFields = { title: z.string(), at: Timestamp, actor: UserId.nullable() };
const DayEventWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("protocol"), id: ProtocolId, ...eventFields }),
  z.object({ kind: z.literal("chart"), id: ChartId, ...eventFields }),
  z.object({ kind: z.literal("talk_through"), id: TalkThroughId, ...eventFields }),
]) satisfies z.ZodType<DayEvent>;

// calendar_events() rows.
export const DayEventRows = z.array(
  z
    .object({ kind: z.enum(["protocol", "chart", "talk_through"]), target: z.uuid(), title: z.string(), at: Timestamp, actor: UserId.nullable() })
    .transform((r, ctx): DayEvent => {
      const parsed = DayEventWire.safeParse({ kind: r.kind, id: r.target, title: r.title, at: r.at, actor: r.actor });
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", message: "bad calendar event" });
        return z.NEVER;
      }
      return parsed.data;
    }),
);

export function eventHref(event: DayEvent): string {
  switch (event.kind) {
    case "protocol":
      return `/protocols/${event.id}`;
    case "chart":
      return `/charts/${event.id}`;
    case "talk_through":
      return `/talk-throughs/${event.id}`;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

// Files on a day come a page at a time per group; the first page rides with the day.
export const DAY_FILES_PAGE = 8;
export const MORE_FILES_PAGE = 50;

export type DayFiles = { kind: RecordKind; groupId: string | null; hits: FileHit[] };
export type DayResponse = { record: RecordGroup[]; events: DayEvent[]; files: DayFiles[] };
export const DayResponse = z.object({
  record: z.array(RecordGroupWire),
  events: z.array(DayEventWire),
  files: z.array(z.object({ kind: RecordKind, groupId: z.string().nullable(), hits: z.array(FileHitWire) })),
}) satisfies z.ZodType<DayResponse>;

export const DayFilesResponse = z.object({ files: z.array(FileHitWire) });

// calendar_files() rows when a day's group is paged through.
export const DayFileRows = z.array(z.object({ sha256: z.string(), kind: RecordKind, group_id: z.uuid().nullable() }));

// Where a plan or a day opens on the calendar, for links from elsewhere.
export function calendarHref(at: { day: CalendarDay; entry?: CalendarEntryId; view?: "month" | "week" }): string {
  const params = new URLSearchParams({ date: at.day });
  if (at.view !== undefined) params.set("view", at.view);
  if (at.entry !== undefined) params.set("entry", at.entry);
  return `/calendar?${params}`;
}
