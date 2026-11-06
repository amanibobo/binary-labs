import {
  CalendarEntryId,
  EntryWire,
  type CalendarEntry,
  type DayEvent,
  type EntryDraft,
  type RangeResponse,
  type RecordGroup,
  type RecordKind,
} from "@/lib/calendar";
import { heldWindow } from "@/lib/calendar-edit";
import { addDays, CalendarDay, daysBetween, instantAt, inRange, weekday } from "@/lib/calendar-time";
import type { FileHit } from "@/lib/domain";
import { ChartId, ProtocolId, TalkThroughId, UserId } from "@/lib/ids";
import type { CalendarApi } from "@/components/calendar/calendar-api";
import type { CalendarLists } from "@/components/calendar/calendar-context";
import { experiments, members, people, recentFiles, searchHits } from "./data";
import { instruments } from "./instruments";
import { authors, protocolList, purification } from "./protocols";

// Dev-only screenshot data: a lab's November 2026 in New York, the week the clocks went back.

export const CALENDAR_TODAY = CalendarDay.parse("2026-11-05");
export const CALENDAR_ZONE = "America/New_York";
export const CALENDAR_NOW = instantAt(CALENDAR_TODAY, 10 * 60 + 20, CALENDAR_ZONE).toISOString();

const d = (s: string) => CalendarDay.parse(s);
const at = (day: string, hour: number, minute = 0) => instantAt(d(day), hour * 60 + minute, CALENDAR_ZONE).toISOString();
const [bm3, solubility] = experiments;
const [ade, priya, jordan] = people;
const reader = instruments[1];
const nanodrop = instruments[2];
const bradford = protocolList[0];
const priyaUser = UserId.parse(members[1]?.userId);
const adeUser = UserId.parse(members[0]?.userId);
let n = 0;

function entry(fields: Omit<Partial<CalendarEntry>, "id"> & Pick<CalendarEntry, "title" | "when">): CalendarEntry {
  n += 1;
  return EntryWire.parse({
    id: `8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c${String(n).padStart(4, "0")}`,
    notes: null,
    experiment: null,
    protocol: null,
    instrument: null,
    people: [],
    createdBy: priyaUser,
    createdAt: "2026-10-28T15:00:00Z",
    updatedAt: "2026-10-28T15:00:00Z",
    ...fields,
  });
}

const readerRef = reader === undefined ? null : { id: reader.id, name: reader.name, revoked: false };
const ref = <I extends string>(p: { id: I; name: string } | undefined) => (p === undefined ? null : { id: p.id, name: p.name });

export const calendarEntries: CalendarEntry[] = [
  entry({ title: "Lab meeting", when: { kind: "timed", start: at("2026-11-02", 10), end: at("2026-11-02", 11) }, createdBy: adeUser }),
  entry({ title: "Lab meeting", when: { kind: "timed", start: at("2026-11-09", 10), end: at("2026-11-09", 11) }, createdBy: adeUser }),
  entry({ title: "Lab meeting", when: { kind: "timed", start: at("2026-11-16", 10), end: at("2026-11-16", 11) }, createdBy: adeUser }),
  entry({
    title: "Overnight culture check",
    // The second 1:30, after the clocks went back.
    when: { kind: "timed", start: "2026-11-01T06:30:00.000Z", end: "2026-11-01T07:15:00.000Z" },
    experiment: ref(bm3),
  }),
  entry({
    title: "Nickel column, batch 5",
    when: { kind: "timed", start: at("2026-11-04", 9), end: at("2026-11-04", 12) },
    experiment: ref(bm3),
    protocol: { id: purification.protocolId, title: purification.title, archived: false },
    people: [ref(priya), ref(ade)].filter((p) => p !== null),
  }),
  entry({
    title: "Plate reads, plates 7 to 9",
    when: { kind: "timed", start: at("2026-11-05", 14), end: at("2026-11-05", 15) },
    experiment: ref(solubility),
    instrument: readerRef,
    people: [ref(jordan)].filter((p) => p !== null),
    createdBy: UserId.parse(members[2]?.userId),
  }),
  entry({
    title: "Bradford standards",
    notes: "Fresh BSA dilutions, 0 to 2 mg/mL. Read at 595 nm after 10 min.",
    when: { kind: "timed", start: at("2026-11-05", 14, 30), end: at("2026-11-05", 16) },
    experiment: ref(bm3),
    protocol: bradford === undefined ? null : { id: bradford.id, title: bradford.title, archived: false },
    instrument: readerRef,
    people: [ref(priya)].filter((p) => p !== null),
  }),
  entry({ title: "Seminar: Dr. Chen", when: { kind: "timed", start: at("2026-11-05", 16), end: at("2026-11-05", 17) }, createdBy: adeUser }),
  entry({
    title: "Dialysis overnight",
    when: { kind: "timed", start: at("2026-11-06", 22), end: at("2026-11-07", 7) },
    experiment: ref(bm3),
  }),
  entry({ title: "Purification week", when: { kind: "allDay", first: d("2026-11-16"), last: d("2026-11-20") }, experiment: ref(bm3) }),
  entry({
    title: "NanoDrop service visit",
    when: { kind: "allDay", first: d("2026-11-12"), last: d("2026-11-12") },
    instrument: nanodrop === undefined ? null : { id: nanodrop.id, name: nanodrop.name, revoked: false },
    createdBy: adeUser,
  }),
  entry({
    title: "Rotation student starts",
    when: { kind: "allDay", first: d("2026-11-09"), last: d("2026-11-09") },
    people: [ref(jordan)].filter((p) => p !== null),
    createdBy: adeUser,
  }),
  entry({ title: "Thanksgiving, lab closed", when: { kind: "allDay", first: d("2026-11-26"), last: d("2026-11-27") }, createdBy: adeUser }),
];

const group = (
  day: string,
  kind: RecordKind,
  items: number,
  name: { id: string; name: string } | null,
  title: string | null = null,
): RecordGroup => ({
  day: d(day),
  kind,
  groupId: name?.id ?? null,
  groupName: name?.name ?? null,
  items,
  title,
});
const readerGroup = reader === undefined ? null : { id: reader.id, name: reader.name };
const bradfordGroup = bradford === undefined ? null : { id: bradford.id, name: bradford.title };

// The record: weekdays busy, weekends quiet, a day after a big copy-in with hundreds of files.
export const calendarRecord: RecordGroup[] = (() => {
  const out: RecordGroup[] = [];
  for (let day = d("2026-10-25"); daysBetween(day, d("2026-12-05")) >= 0; day = addDays(day, 1)) {
    const seed = Number(day.slice(8)) + Number(day.slice(5, 7)) * 31;
    const weekend = weekday(day) === 0 || weekday(day) === 6;
    if (daysBetween(day, CALENDAR_TODAY) < 0) continue;
    if (weekend) {
      if (seed % 3 === 0) out.push(group(day, "file", 1 + (seed % 2), null, "Bench notes"));
      continue;
    }
    out.push(group(day, "file", 4 + ((seed * 7) % 15), ref(bm3)));
    if (seed % 2 === 0) out.push(group(day, "file", 2 + (seed % 5), ref(solubility)));
    if (seed % 3 !== 1) out.push(group(day, "upload", 1 + (seed % 4), ref(bm3)));
    if (seed % 2 === 1) out.push(group(day, "instrument", 6 + ((seed * 5) % 30), readerGroup));
    if (seed % 5 === 0) out.push(group(day, "protocol", 1, bradfordGroup));
    if (seed % 7 === 2) out.push(group(day, "chart", 1, null, "Plate 7 absorbance"));
  }
  const nov3 = [
    group("2026-11-03", "file", 342, ref(bm3)),
    group("2026-11-03", "file", 4, ref(solubility)),
    group("2026-11-03", "upload", 2, ref(bm3)),
    group("2026-11-03", "instrument", 24, readerGroup),
    group("2026-11-03", "protocol", 2, { id: purification.protocolId, name: purification.title }),
    group("2026-11-03", "chart", 1, null, "Plate 7 absorbance"),
    group("2026-11-03", "talk_through", 1, null, purification.title),
  ];
  return [...out.filter((g) => g.day !== "2026-11-03"), ...nov3];
})();

// Files from the search fixtures, labeled with the day they're shown on.
const files = (seeds: string[], day: CalendarDay): FileHit[] =>
  [...searchHits, ...recentFiles]
    .filter((h, i, all) => seeds.includes(h.sha256[0] ?? "") && all.findIndex((x) => x.sha256 === h.sha256) === i)
    .map((h) => ({ ...h, matchedBy: [], label: h.label === null ? null : { ...h.label, date: day } }));

function dayEvents(day: CalendarDay): DayEvent[] {
  if (day !== "2026-11-03") return [];
  return [
    { kind: "protocol", id: ProtocolId.parse(purification.protocolId), title: purification.title, at: at("2026-11-03", 9, 12), actor: priyaUser },
    { kind: "protocol", id: ProtocolId.parse(purification.protocolId), title: purification.title, at: at("2026-11-03", 15, 40), actor: priyaUser },
    {
      kind: "chart",
      id: ChartId.parse("9d1c2c39-5a4e-4c55-9d7b-0c3c1a7d0001"),
      title: "Plate 7 absorbance",
      at: at("2026-11-03", 11, 5),
      actor: UserId.parse(members[2]?.userId),
    },
    {
      kind: "talk_through",
      id: TalkThroughId.parse("9d1c2c39-5a4e-4c55-9d7b-0c3c1a7d0002"),
      title: purification.title,
      at: at("2026-11-03", 17, 20),
      actor: priyaUser,
    },
  ];
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// An in-memory calendar: writes land in this page's copy and nowhere else.
export function createFixtureCalendar(): CalendarApi {
  let entries = [...calendarEntries];
  const record = calendarRecord;
  return {
    range: async ({ range, filters }) => {
      await wait(60);
      const plans = entries.filter(
        (e) =>
          (filters.experiment === undefined || e.experiment?.id === filters.experiment) &&
          (filters.person === undefined || e.people.some((p) => p.id === filters.person)) &&
          (filters.instrument === undefined || e.instrument?.id === filters.instrument),
      );
      const shown = record.filter(
        (g) =>
          inRange(g.day, range) &&
          (filters.experiment === undefined || g.groupId === filters.experiment) &&
          (filters.instrument === undefined || g.groupId === filters.instrument) &&
          filters.person === undefined,
      );
      return { record: shown, plans } satisfies RangeResponse;
    },
    day: async ({ day }) => {
      await wait(80);
      const groups = record.filter((g) => g.day === day);
      const hitsFor = (g: RecordGroup): FileHit[] => {
        if (g.kind === "upload") return files(["c"], day).slice(0, g.items);
        if (g.kind === "instrument") return files(["f", "e"], day).slice(0, Math.min(g.items, 3));
        if (g.groupId === solubility?.id) return files(["f", "8"], day).slice(0, g.items);
        return files(["b", "d", "a", "9"], day).slice(0, Math.min(g.items, 4));
      };
      return {
        record: groups,
        events: dayEvents(day),
        files: groups
          .filter((g) => g.kind === "file" || g.kind === "upload" || g.kind === "instrument")
          .map((g) => ({ kind: g.kind, groupId: g.groupId, hits: hitsFor(g) })),
      };
    },
    dayFiles: async () => {
      await wait(150);
      return [];
    },
    overlaps: async ({ instrumentId, from, to, except }) => {
      await wait(60);
      return entries.filter((e) => {
        if (e.instrument?.id !== instrumentId || e.id === except) return false;
        const held = heldWindow(e.when, CALENDAR_ZONE);
        return Date.parse(held.from) < Date.parse(to) && Date.parse(held.to) > Date.parse(from);
      });
    },
    createEntry: async (draft: EntryDraft) => {
      await wait(120);
      const created = fromDraft(CalendarEntryId.parse(crypto.randomUUID()), draft, null);
      entries = [...entries, created];
      return created;
    },
    saveEntry: async (id, draft) => {
      await wait(120);
      const before = entries.find((e) => e.id === id) ?? null;
      const saved = fromDraft(id, draft, before);
      entries = entries.map((e) => (e.id === id ? saved : e));
      return { kind: "saved", entry: saved };
    },
    deleteEntry: async (id) => {
      await wait(100);
      entries = entries.filter((e) => e.id !== id);
    },
  };
}

function fromDraft(id: CalendarEntryId, draft: EntryDraft, before: CalendarEntry | null): CalendarEntry {
  const now = new Date().toISOString();
  const experiment = experiments.find((e) => e.id === draft.experimentId);
  const protocol = protocolList.find((p) => p.id === draft.protocolId);
  const instrument = instruments.find((i) => i.id === draft.instrumentId);
  return {
    id,
    title: draft.title.trim(),
    notes: draft.notes,
    when: draft.when,
    experiment: experiment === undefined ? null : { id: experiment.id, name: experiment.name },
    protocol: protocol === undefined ? null : { id: protocol.id, title: protocol.title, archived: false },
    instrument: instrument === undefined ? null : { id: instrument.id, name: instrument.name, revoked: false },
    people: draft.personIds.flatMap((pid) => people.filter((p) => p.id === pid).map((p) => ({ id: p.id, name: p.name }))),
    createdBy: before?.createdBy ?? priyaUser,
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
  };
}

export const calendarLists: CalendarLists = {
  experiments,
  people,
  instruments: instruments.map((i) => ({ id: i.id, name: i.name, live: i.state.kind !== "revoked" })),
  protocols: protocolList.map((p) => ({ id: p.id, title: p.title })),
  authors,
};

// The protocol page's "On the calendar": Bradford's coming entries.
export const bradfordPlans = calendarEntries.filter((e) => e.protocol?.id === bradford?.id || e.protocol?.id === purification.protocolId);
