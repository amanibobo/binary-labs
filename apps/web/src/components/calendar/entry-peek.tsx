"use client";

import { useQuery } from "@tanstack/react-query";
import { DropdownMenu } from "radix-ui";
import { useId, useState, type ReactNode } from "react";
import { draftOf, entryDays, type CalendarEntry, type EntryDraft, type EntryWhen } from "@/lib/calendar";
import {
  choiceOf,
  clampUntil,
  defaultUntil,
  reminderChoices,
  reminderName,
  repeatChoices,
  ruleName,
  WEEKDAY_LETTERS,
  weekdayName,
  type RepeatRule,
  type Weekday,
} from "@/lib/calendar-repeat";
import type { InstrumentId } from "@/lib/ids";
import { heldWindow, moveEnd, moveStart, toggleAllDay, whenLine } from "@/lib/calendar-edit";
import { CalendarDay, formatCalendarDay, minutesFromInput, timeInputValue, wallClock } from "@/lib/calendar-time";
import { cn } from "@/lib/cn";
import { authorName } from "@/lib/protocols";
import { CheckIcon, ChevronDownIcon } from "../icons/base-web";
import { InfoIcon } from "../icons/drawn";
import { Button } from "../ui/button";
import { inputVariants } from "../ui/field";
import { menuItem, menuSurface } from "../ui/menu";
import { When } from "../ui/when";
import { useCalendarApi } from "./calendar-api";
import { useCalendar } from "./calendar-context";
import { SidePeek } from "./side-peek";
import type { EntryWrites } from "./use-entry-writes";

const blankDraft = (when: EntryWhen): EntryDraft => ({
  title: "",
  notes: null,
  when,
  experimentId: null,
  protocolId: null,
  instrumentId: null,
  personIds: [],
});

// The side peek for one entry, or a new one. Every change saves as it's made, as in Notion: a
// pick at once, the title and notes when you leave them. A new entry is saved once it has a title.
export function EntryPeek({
  entry,
  newWhen,
  writes,
  onClose,
  onCreated,
}: {
  entry: CalendarEntry | null;
  newWhen: EntryWhen;
  writes: EntryWrites;
  onClose: () => void;
  onCreated: (entry: CalendarEntry) => void;
}) {
  const { timeZone, lists } = useCalendar();
  const titleId = useId();
  // The entry this draft was loaded from; a different one (someone else's save) reloads it.
  const [loaded, setLoaded] = useState(entry?.updatedAt ?? null);
  const [draft, setDraft] = useState<EntryDraft>(() => (entry === null ? blankDraft(newWhen) : draftOf(entry)));
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A new entry keeps how it repeats and its reminders until it's saved with a title.
  const [newRepeat, setNewRepeat] = useState<RepeatRule | null>(null);
  const [newReminders, setNewReminders] = useState<number[]>([]);
  if (entry !== null && entry.updatedAt !== loaded) {
    setLoaded(entry.updatedAt);
    setDraft((current) => ({ ...draftOf(entry), title: document.activeElement?.id === titleId ? current.title : entry.title }));
  }

  async function commit(next: EntryDraft) {
    setDraft(next);
    if (next.title.trim() === "") return;
    if (entry === null) {
      const created = await writes.create(next, { repeat: newRepeat, reminders: newReminders });
      if (created !== null) onCreated(created);
      return;
    }
    const saved = await writes.save(entry, next);
    // Backing out of "only this one or all?" puts the fields back.
    if (saved === null) setDraft(draftOf(entry));
    else setLoaded(saved.updatedAt);
  }

  const change = (patch: Partial<EntryDraft>) => void commit({ ...draft, ...patch });
  const instrument = lists.instruments.find((i) => i.id === draft.instrumentId) ?? null;
  const startDay = entryDays(draft.when, timeZone).first;
  const rep = entry?.repeat ?? null;
  const rule = entry === null ? newRepeat : (rep?.rule ?? null);
  const reminders = entry === null ? newReminders : entry.reminders;

  return (
    <SidePeek
      labelledBy={titleId}
      onClose={onClose}
      tools={
        entry === null ? null : confirmDelete && rep !== null ? (
          <>
            <span className="text-paragraph-small text-content-secondary max-sm:sr-only">Delete for everyone?</span>
            <Button variant="tertiary" size="compact" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
            <Button variant="negative" size="compact" onClick={() => void writes.remove(entry, "one")}>
              Only this one
            </Button>
            <Button variant="negative" size="compact" onClick={() => void writes.remove(entry, "all")}>
              All {rep.count}
            </Button>
          </>
        ) : confirmDelete ? (
          <>
            <span className="text-paragraph-small text-content-secondary max-sm:sr-only">Delete for everyone?</span>
            <Button variant="tertiary" size="compact" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
            <Button variant="negative" size="compact" onClick={() => void writes.remove(entry, "one")}>
              Delete
            </Button>
          </>
        ) : (
          <Button variant="tertiary" size="compact" className="text-content-secondary" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        )
      }
    >
      <input
        id={titleId}
        autoFocus={entry === null}
        aria-label="Title"
        placeholder="Untitled"
        value={draft.title}
        maxLength={200}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        onBlur={() => {
          if (draft.title.trim() !== (entry?.title ?? "")) void commit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-full bg-transparent text-heading-medium text-content-primary outline-none placeholder:text-content-tertiary"
      />
      {entry === null && draft.title.trim() === "" ? (
        <p className="mt-1 text-paragraph-small text-content-tertiary">Give it a title to save it.</p>
      ) : null}

      <dl className="mt-6 grid grid-cols-1 items-start gap-x-3 gap-y-1 sm:grid-cols-[112px_minmax(0,1fr)]">
        <Property label="When">
          <WhenFields when={draft.when} onChange={(when) => change({ when })} />
        </Property>
        <Property label="Repeat">
          <RepeatField
            day={startDay}
            rule={rule}
            fromHere={rep !== null && rep.occurrenceOn !== rep.firstOn}
            onChange={(next) => {
              if (entry === null) setNewRepeat(next);
              else void writes.repeat(entry, next);
            }}
          />
        </Property>
        <Property label="Remind me">
          <ReminderField
            allDay={draft.when.kind === "allDay"}
            value={reminders}
            onChange={(next) => {
              if (entry === null) setNewReminders(next);
              else void writes.remind(entry, next);
            }}
          />
        </Property>
        <Property label="Experiment">
          <Picker
            value={draft.experimentId}
            none="None"
            options={lists.experiments.map((e) => ({ id: e.id, name: e.name }))}
            onChange={(experimentId) => change({ experimentId })}
            label="Experiment"
          />
        </Property>
        <Property label="Protocol">
          <Picker
            value={draft.protocolId}
            none="None"
            options={withCurrent(
              lists.protocols.map((p) => ({ id: p.id, name: p.title })),
              entry?.protocol ? { id: entry.protocol.id, name: entry.protocol.title } : null,
            )}
            onChange={(protocolId) => change({ protocolId })}
            label="Protocol"
          />
        </Property>
        <Property label="Instrument">
          <Picker
            value={draft.instrumentId}
            none="None"
            options={withCurrent(
              lists.instruments.filter((i) => i.live).map((i) => ({ id: i.id, name: i.name })),
              entry?.instrument ? { id: entry.instrument.id, name: entry.instrument.name } : null,
            )}
            onChange={(instrumentId) => change({ instrumentId })}
            label="Instrument"
          />
          {instrument === null ? null : <OverlapNotice instrument={instrument} when={draft.when} except={entry} />}
        </Property>
        <Property label="People">
          <PeoplePicker value={draft.personIds} onChange={(personIds) => change({ personIds })} />
        </Property>
      </dl>

      <label className="mt-6 block">
        <span className="sr-only">Notes</span>
        <textarea
          placeholder="Add notes"
          value={draft.notes ?? ""}
          rows={5}
          maxLength={10_000}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          onBlur={() => {
            if ((draft.notes ?? "").trim() !== (entry?.notes ?? "")) void commit({ ...draft, notes: draft.notes?.trim() || null });
          }}
          className="w-full resize-y rounded-control border border-transparent bg-transparent px-0 py-2 text-paragraph-medium text-content-primary outline-none placeholder:text-content-tertiary focus:border-border-opaque focus:px-3"
        />
      </label>

      {entry === null ? null : (
        <p className="mt-8 border-t border-border-opaque pt-4 text-paragraph-xsmall text-content-tertiary">
          Added by {authorName(lists.authors, entry.createdBy)} on <When iso={entry.createdAt} />
          <span className="sr-only">. {whenLine(entry.when, timeZone)}</span>
        </p>
      )}
    </SidePeek>
  );
}

// An archived protocol or a removed instrument an entry already names stays pickable on it.
function withCurrent<T extends string>(options: { id: T; name: string }[], current: { id: T; name: string } | null) {
  return current === null || options.some((o) => o.id === current.id) ? options : [...options, current];
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex items-center pt-2 text-paragraph-small text-content-tertiary sm:min-h-9 sm:pt-0">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

const fieldTrigger =
  "-ml-2 flex min-h-11 max-w-full items-center gap-1 rounded-control px-2 text-left text-paragraph-medium transition-colors duration-150 hover:bg-background-secondary sm:min-h-9";

function Picker<T extends string>({
  value,
  none,
  options,
  onChange,
  label,
}: {
  value: T | null;
  none: string;
  options: { id: T; name: string }[];
  onChange: (next: T | null) => void;
  label: string;
}) {
  const current = options.find((o) => o.id === value) ?? null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={`${label}: ${current?.name ?? none}`} className={fieldTrigger}>
        <span className={cn("truncate", current === null && "text-content-tertiary")}>{current?.name ?? none}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-content-tertiary" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={cn(menuSurface, "max-h-80 overflow-y-auto")}>
          <DropdownMenu.RadioGroup value={value ?? ""} onValueChange={(next) => onChange(options.find((o) => o.id === next)?.id ?? null)}>
            {[{ id: "", name: none }, ...options].map((o) => (
              <DropdownMenu.RadioItem key={o.id} value={o.id} className={menuItem}>
                <span className={cn("flex-1 truncate", o.id === "" && "text-content-tertiary")}>{o.name}</span>
                <DropdownMenu.ItemIndicator>
                  <CheckIcon className="size-5" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function PeoplePicker({ value, onChange }: { value: EntryDraft["personIds"]; onChange: (next: EntryDraft["personIds"]) => void }) {
  const { lists } = useCalendar();
  const chosen = value.flatMap((id) => lists.people.filter((p) => p.id === id));
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={`People: ${chosen.map((p) => p.name).join(", ") || "none"}`} className={fieldTrigger}>
        <span className={cn("truncate", chosen.length === 0 && "text-content-tertiary")}>
          {chosen.length === 0 ? "Add people" : chosen.map((p) => p.name).join(", ")}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-content-tertiary" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={cn(menuSurface, "max-h-80 overflow-y-auto")}>
          {lists.people.map((p) => (
            <DropdownMenu.CheckboxItem
              key={p.id}
              checked={value.includes(p.id)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => onChange(on ? [...value, p.id] : value.filter((id) => id !== p.id))}
              className={menuItem}
            >
              <span className="flex-1 truncate">{p.name}</span>
              <DropdownMenu.ItemIndicator>
                <CheckIcon className="size-5" />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const dateField = cn(inputVariants({ size: "compact" }), "w-auto min-w-0 px-2 tabular-nums [color-scheme:inherit]");

function WhenFields({ when, onChange }: { when: EntryWhen; onChange: (next: EntryWhen) => void }) {
  const { timeZone } = useCalendar();
  const id = useId();
  const allDay = when.kind === "allDay";
  const start = when.kind === "allDay" ? { day: when.first, minutes: null } : wallClock(new Date(when.start), timeZone);
  const end = when.kind === "allDay" ? { day: when.last, minutes: null } : wallClock(new Date(when.end), timeZone);
  const row = (edge: "start" | "end") => {
    const at = edge === "start" ? start : end;
    const move = edge === "start" ? moveStart : moveEnd;
    const word = edge === "start" ? "Starts" : "Ends";
    return (
      <div className="flex items-center gap-2">
        <span className="w-11 shrink-0 text-paragraph-small text-content-tertiary">{word}</span>
        <input
          type="date"
          aria-label={`${word} on`}
          className={dateField}
          value={at.day}
          onChange={(e) => {
            const d = CalendarDay.safeParse(e.target.value);
            if (d.success) onChange(move(when, { day: d.data, minutes: at.minutes }, timeZone));
          }}
        />
        {at.minutes === null ? null : (
          <input
            type="time"
            step={900}
            aria-label={`${word} at`}
            className={dateField}
            value={timeInputValue(at.minutes)}
            onChange={(e) => {
              const m = minutesFromInput(e.target.value);
              if (m !== null) onChange(move(when, { day: at.day, minutes: m }, timeZone));
            }}
          />
        )}
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-2 py-1">
      {row("start")}
      {row("end")}
      <label htmlFor={`${id}-all-day`} className="flex w-fit cursor-pointer items-center gap-2 pt-1 text-paragraph-small text-content-secondary">
        <button
          id={`${id}-all-day`}
          type="button"
          role="switch"
          aria-checked={allDay}
          onClick={() => onChange(toggleAllDay(when, timeZone))}
          className={cn(
            "relative h-5 w-8 shrink-0 rounded-full transition-colors duration-150",
            allDay ? "bg-button-primary-fill" : "bg-background-tertiary ring-1 ring-border-raised ring-inset",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0 size-4 rounded-full bg-background-raised shadow-raised transition-transform duration-150",
              allDay ? "translate-x-3.5" : "translate-x-0.5",
            )}
          />
        </button>
        All day
      </label>
    </div>
  );
}

// A quiet line when someone else has booked the instrument then. It never stops a save.
function OverlapNotice({
  instrument,
  when,
  except,
}: {
  instrument: { id: InstrumentId; name: string };
  when: EntryWhen;
  except: CalendarEntry | null;
}) {
  const api = useCalendarApi();
  const { timeZone } = useCalendar();
  const window = heldWindow(when, timeZone);
  const overlaps = useQuery({
    queryKey: ["calendar", "overlaps", instrument.id, window.from, window.to, except?.id ?? null],
    queryFn: ({ signal }) => api.overlaps({ instrumentId: instrument.id, ...window, timeZone, except: except?.id ?? null }, signal),
  });
  const first = overlaps.data?.[0];
  if (first === undefined) return null;
  const others = (overlaps.data?.length ?? 1) - 1;
  const { first: firstDay, last: lastDay } = entryDays(first.when, timeZone);
  const at =
    firstDay !== lastDay
      ? whenLine(first.when, timeZone)
      : `${formatCalendarDay(firstDay, "medium")}, ${first.when.kind === "allDay" ? "all day" : whenLine(first.when, timeZone)}`;
  return (
    <p role="status" className="mt-1 mb-2 flex gap-2 rounded-control bg-background-secondary px-3 py-2 text-paragraph-small text-content-secondary">
      <InfoIcon className="mt-0.5 size-4 shrink-0 text-content-tertiary" />
      <span>
        {instrument.name} is also booked {at}, for “{first.title}”{others > 0 ? `, and ${others} more` : ""}.
      </span>
    </p>
  );
}

// How an entry repeats: a menu of the usual rules, then the days of the week for a weekly one
// and the day it stops. Every change saves at once.
function RepeatField({
  day,
  rule,
  fromHere,
  onChange,
}: {
  day: CalendarDay;
  rule: RepeatRule | null;
  // Changing the rule from a later occurrence leaves the earlier ones as they were.
  fromHere: boolean;
  onChange: (next: RepeatRule | null) => void;
}) {
  const until = rule?.until ?? defaultUntil(day);
  const choices = repeatChoices(day, until);
  const current = choiceOf(rule, day);
  const name = rule === null ? "Doesn't repeat" : (choices.find((c) => c.id === current)?.label ?? ruleName(rule, day));
  return (
    <div className="flex flex-col gap-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger aria-label={`Repeat: ${name}`} className={fieldTrigger}>
          <span className={cn("truncate", rule === null && "text-content-tertiary")}>{name}</span>
          <ChevronDownIcon className="size-4 shrink-0 text-content-tertiary" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className={menuSurface}>
            <DropdownMenu.RadioGroup value={current ?? ""} onValueChange={(id) => onChange(choices.find((c) => c.id === id)?.rule ?? null)}>
              {choices.map((c) => (
                <DropdownMenu.RadioItem key={c.id} value={c.id} className={menuItem}>
                  <span className={cn("flex-1 truncate", c.rule === null && "text-content-tertiary")}>{c.label}</span>
                  <DropdownMenu.ItemIndicator>
                    <CheckIcon className="size-5" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {rule === null ? null : (
        <div className="flex flex-col gap-2 pb-1">
          {rule.every === "week" ? (
            <div role="group" aria-label="On these days" className="flex gap-1">
              {WEEKDAYS.map((d) => {
                const on = rule.weekdays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    aria-label={weekdayName(d)}
                    title={weekdayName(d)}
                    onClick={() => {
                      const [first, ...rest] = on ? rule.weekdays.filter((w) => w !== d) : [...rule.weekdays, d].sort((a, b) => a - b);
                      if (first !== undefined) onChange({ ...rule, weekdays: [first, ...rest] });
                    }}
                    className={cn(
                      "size-9 rounded-full text-label-small transition-colors duration-150 sm:size-8",
                      on
                        ? "bg-button-primary-fill text-content-inverse-primary"
                        : "text-content-secondary ring-1 ring-border-opaque ring-inset hover:bg-background-secondary",
                    )}
                  >
                    {WEEKDAY_LETTERS[d]}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <span className="w-11 shrink-0 text-paragraph-small text-content-tertiary">Until</span>
            <input
              type="date"
              aria-label="Repeats until"
              className={dateField}
              value={rule.until}
              min={day}
              onChange={(e) => {
                const d = CalendarDay.safeParse(e.target.value);
                if (d.success) onChange({ ...rule, until: clampUntil(day, d.data) });
              }}
            />
          </div>
          {fromHere ? <p className="text-paragraph-small text-content-tertiary">A change here starts from this one; earlier ones stay as they were.</p> : null}
        </div>
      )}
    </div>
  );
}

const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

// The member's own reminders, any of a few, shown in Binary when they're due.
function ReminderField({ allDay, value, onChange }: { allDay: boolean; value: number[]; onChange: (next: number[]) => void }) {
  const choices = [...new Set([...reminderChoices(allDay), ...value])].sort((a, b) => a - b);
  const names = value.map((m) => reminderName(m, allDay)).join(", ");
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={`Remind me: ${names || "none"}`} className={fieldTrigger}>
        <span className={cn("truncate", value.length === 0 && "text-content-tertiary")}>{value.length === 0 ? "None" : names}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-content-tertiary" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={menuSurface}>
          {choices.map((m) => (
            <DropdownMenu.CheckboxItem
              key={m}
              checked={value.includes(m)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => onChange(on ? [...value, m].sort((a, b) => a - b) : value.filter((v) => v !== m))}
              className={menuItem}
            >
              <span className="flex-1 truncate">{reminderName(m, allDay)}</span>
              <DropdownMenu.ItemIndicator>
                <CheckIcon className="size-5" />
              </DropdownMenu.ItemIndicator>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
