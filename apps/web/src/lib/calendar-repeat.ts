import { z } from "zod";
import { addDays, CalendarDay, daysBetween, dayNumber, formatCalendarDay, weekday } from "./calendar-time";

// Repeating entries and reminders (docs/decisions.md, "the calendar: repeats, reminders, a feed
// and notes"). A rule lives on a series; each occurrence is its own entry the database made
// from it (calendar_repeat in db/migrations/0030_calendar_repeats.sql).

export const SeriesId = z.uuid().brand<"SeriesId">();
export type SeriesId = z.infer<typeof SeriesId>;

// 0 is Sunday, as weekday() counts.
export const Weekday = z.number().int().min(0).max(6);
export type Weekday = z.infer<typeof Weekday>;

// A rule runs up to a year from its first day, as calendar_series checks.
export const MAX_REPEAT_DAYS = 366;

export type RepeatRule =
  | { every: "day"; until: CalendarDay }
  | { every: "week"; step: 1 | 2 | 3 | 4; weekdays: [Weekday, ...Weekday[]]; until: CalendarDay }
  | { every: "month"; until: CalendarDay };

export const RepeatRuleWire = z.discriminatedUnion("every", [
  z.object({ every: z.literal("day"), until: CalendarDay }),
  z.object({
    every: z.literal("week"),
    step: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    weekdays: z.tuple([Weekday], Weekday),
    until: CalendarDay,
  }),
  z.object({ every: z.literal("month"), until: CalendarDay }),
]) satisfies z.ZodType<RepeatRule>;

// Where an occurrence sits in its series.
export type EntryRepeat = {
  seriesId: SeriesId;
  rule: RepeatRule;
  firstOn: CalendarDay;
  // The day the rule put this one on; it stays when the occurrence is moved.
  occurrenceOn: CalendarDay;
  count: number;
};

export const EntryRepeatWire = z.object({
  seriesId: SeriesId,
  rule: RepeatRuleWire,
  firstOn: CalendarDay,
  occurrenceOn: CalendarDay,
  count: z.number().int().positive(),
}) satisfies z.ZodType<EntryRepeat>;

// calendar_entry_json()'s repeat.
export const RepeatJson = z
  .object({
    series_id: SeriesId,
    every: z.enum(["day", "week", "month"]),
    step: z.number().int(),
    weekdays: z.array(Weekday),
    first_on: CalendarDay,
    until_on: CalendarDay,
    occurrence_on: CalendarDay,
    count: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]),
  })
  .transform((r, ctx): EntryRepeat => {
    const rule = RepeatRuleWire.safeParse({ every: r.every, step: r.step, weekdays: [...r.weekdays].sort(), until: r.until_on });
    if (!rule.success) {
      ctx.addIssue({ code: "custom", message: "bad repeat rule" });
      return z.NEVER;
    }
    return { seriesId: r.series_id, rule: rule.data, firstOn: r.first_on, occurrenceOn: r.occurrence_on, count: r.count };
  });

// What a change to an occurrence reaches.
export type ChangeScope = "one" | "all";
export const ChangeScope = z.enum(["one", "all"]);

// The rule's columns as calendar_repeat reads them.
export function ruleArg(rule: RepeatRule) {
  return rule.every === "week" ? { every: "week", step: rule.step, weekdays: rule.weekdays, until: rule.until } : { every: rule.every, until: rule.until };
}

// A new repeat runs 13 weeks, about a term, unless changed; weekly ones end on their weekday.
export function defaultUntil(first: CalendarDay): CalendarDay {
  return addDays(first, 91);
}

export function clampUntil(first: CalendarDay, until: CalendarDay): CalendarDay {
  if (daysBetween(first, until) < 0) return first;
  return daysBetween(first, until) > MAX_REPEAT_DAYS ? addDays(first, MAX_REPEAT_DAYS) : until;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WORK_WEEK = [1, 2, 3, 4, 5];

export function weekdayName(day: Weekday): string {
  return WEEKDAY_NAMES[day] ?? "";
}

function andList(words: readonly string[]): string {
  if (words.length <= 2) return words.join(" and ");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${tail}`;
}

// "Every Tuesday", "Every weekday", "Every 2 weeks on Monday and Thursday", "Every month on the 18th".
export function ruleName(rule: RepeatRule, firstOn: CalendarDay): string {
  switch (rule.every) {
    case "day":
      return "Every day";
    case "month":
      return `Every month on the ${ordinal(dayNumber(firstOn))}`;
    case "week": {
      const days = rule.weekdays;
      if (rule.step === 1 && days.length === 5 && WORK_WEEK.every((d) => days.includes(d))) return "Every weekday";
      const names = andList(days.map(weekdayName));
      return rule.step === 1 ? `Every ${names}` : `Every ${rule.step} weeks on ${names}`;
    }
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}

// "Every Tuesday until Feb 18".
export function repeatLine(rule: RepeatRule, firstOn: CalendarDay): string {
  return `${ruleName(rule, firstOn)} until ${formatCalendarDay(rule.until, "monthDay")}`;
}

export type RepeatChoice = { id: string; label: string; rule: RepeatRule | null };

// The repeat menu for an entry on `day`, as Google Calendar lists it. A rule already set keeps
// its end date when another is picked.
export function repeatChoices(day: CalendarDay, until: CalendarDay): RepeatChoice[] {
  const dow = Weekday.parse(weekday(day));
  const choices: RepeatChoice[] = [
    { id: "none", label: "Doesn't repeat", rule: null },
    { id: "day", label: "Every day", rule: { every: "day", until } },
    { id: "weekday", label: "Every weekday", rule: { every: "week", step: 1, weekdays: [1, 2, 3, 4, 5], until } },
    { id: "week", label: `Every ${weekdayName(dow)}`, rule: { every: "week", step: 1, weekdays: [dow], until } },
    { id: "week2", label: `Every 2 weeks on ${weekdayName(dow)}`, rule: { every: "week", step: 2, weekdays: [dow], until } },
    { id: "month", label: `Every month on the ${ordinal(dayNumber(day))}`, rule: { every: "month", until } },
  ];
  return choices;
}

// Which choice a rule is, by its name; null for days picked one by one.
export function choiceOf(rule: RepeatRule | null, day: CalendarDay): string | null {
  if (rule === null) return "none";
  const name = ruleName(rule, day);
  return repeatChoices(day, rule.until).find((c) => c.rule !== null && ruleName(c.rule, day) === name)?.id ?? null;
}

// Reminders, in minutes before the start. An all-day entry starts at 9 am where you are.
export const REMINDER_LIMIT = 5;
export const Reminders = z.array(z.number().int().min(0).max(40_320)).max(REMINDER_LIMIT);

const TIMED_REMINDERS = [0, 5, 15, 30, 60, 1440] as const;
const ALL_DAY_REMINDERS = [0, 1440, 10_080] as const;

export function reminderChoices(allDay: boolean): readonly number[] {
  return allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS;
}

// "15 minutes before", "1 day before", "At the start"; for all day "On the day, 9 AM".
export function reminderName(minutes: number, allDay: boolean): string {
  if (allDay) {
    if (minutes === 0) return "On the day, 9 AM";
    if (minutes === 1440) return "The day before, 9 AM";
  }
  if (minutes === 0) return "At the start";
  if (minutes % 10_080 === 0) return minutes === 10_080 ? "1 week before" : `${minutes / 10_080} weeks before`;
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 day before" : `${minutes / 1440} days before`;
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour before" : `${minutes / 60} hours before`;
  return minutes === 1 ? "1 minute before" : `${minutes} minutes before`;
}

// "Starts in 15 minutes", "Starts tomorrow", "Started 5 minutes ago": a reminder's line.
export function startsLine(startMs: number, nowMs: number): string {
  const minutes = Math.round((startMs - nowMs) / 60_000);
  if (Math.abs(minutes) < 1) return "Starting now";
  const span = (m: number) => {
    if (m < 60) return m === 1 ? "1 minute" : `${m} minutes`;
    if (m < 1440) {
      const h = Math.round(m / 60);
      return h === 1 ? "1 hour" : `${h} hours`;
    }
    const d = Math.round(m / 1440);
    return d === 1 ? "1 day" : `${d} days`;
  };
  return minutes > 0 ? `Starts in ${span(minutes)}` : `Started ${span(-minutes)} ago`;
}

// The days a rule lands on from its first day, both ends included; calendar_repeat_days in SQL.
export function repeatDays(rule: RepeatRule, first: CalendarDay): CalendarDay[] {
  const weekOne = addDays(first, -weekday(first));
  const out: CalendarDay[] = [];
  for (let day = first; daysBetween(day, rule.until) >= 0; day = addDays(day, 1)) {
    const lands =
      rule.every === "day" ||
      (rule.every === "month" && dayNumber(day) === dayNumber(first)) ||
      (rule.every === "week" && rule.weekdays.includes(Weekday.parse(weekday(day))) && Math.floor(daysBetween(weekOne, day) / 7) % rule.step === 0);
    if (lands) out.push(day);
  }
  return out;
}
