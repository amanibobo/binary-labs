"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";
import { draftOf, type CalendarEntry, type EntryDraft, type RangeResponse } from "@/lib/calendar";
import { shiftWhen } from "@/lib/calendar-edit";
import type { ChangeScope, RepeatRule } from "@/lib/calendar-repeat";
import { daysBetween } from "@/lib/calendar-time";
import { useCalendarApi } from "./calendar-api";

export type EntryWrites = {
  // Each resolves to the entry as it now stands, or null when the write didn't happen.
  create: (draft: EntryDraft, extra?: { repeat: RepeatRule | null; reminders: number[] }) => Promise<CalendarEntry | null>;
  // An occurrence of a series asks first whether the change is for it alone or all of them.
  save: (entry: CalendarEntry, draft: EntryDraft, how?: { ask: "always" | "once" }) => Promise<CalendarEntry | null>;
  repeat: (entry: CalendarEntry, rule: RepeatRule | null) => Promise<CalendarEntry | null>;
  remind: (entry: CalendarEntry, minutes: number[]) => Promise<CalendarEntry | null>;
  remove: (entry: CalendarEntry, scope: ChangeScope) => Promise<void>;
};

// Asks "this one or all of them?" for an occurrence; null when the person backed out. "once"
// may answer from the last time the same entry asked.
export type AskScope = (entry: CalendarEntry, how: { ask: "always" | "once" }) => Promise<ChangeScope | null>;

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

// Writes go on screen at once and to the server one at a time per entry, each based on the
// version the last one returned, so a drag and a quick edit never trip over each other.
export function useEntryWrites({ timeZone, askScope }: { timeZone: string; askScope: AskScope }): EntryWrites {
  const api = useCalendarApi();
  const queryClient = useQueryClient();
  const queues = useRef(new Map<string, Promise<unknown>>());
  const latest = useRef(new Map<string, CalendarEntry>());

  const patch = (fn: (plans: CalendarEntry[]) => CalendarEntry[]) =>
    queryClient.setQueriesData<RangeResponse>({ queryKey: ["calendar", "range"] }, (old) =>
      old === undefined ? old : { ...old, plans: fn(old.plans) },
    );
  const put = (entry: CalendarEntry) => {
    latest.current.set(entry.id, entry);
    patch((plans) => (plans.some((p) => p.id === entry.id) ? plans.map((p) => (p.id === entry.id ? entry : p)) : [...plans, entry]));
  };
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: ["calendar"] });
  };
  const queued = <T>(id: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.current.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
    queues.current.set(id, next);
    return next;
  };
  // A change to a whole series rewrites rows this page never saw, so their versions are old.
  const forgetSeries = (entry: CalendarEntry) => {
    for (const [id, known] of latest.current) if (known.repeat?.seriesId === entry.repeat?.seriesId) latest.current.delete(id);
  };
  const scopeFor = async (entry: CalendarEntry, how: { ask: "always" | "once" }): Promise<ChangeScope | null> =>
    entry.repeat === null ? "one" : askScope(entry, how);

  // A save or a repeat answers with the entry, or that someone else got there first.
  function landed(entry: CalendarEntry, outcome: { kind: "saved" | "stale"; entry: CalendarEntry | null }): CalendarEntry | null {
    if (outcome.kind === "saved" && outcome.entry !== null) {
      put(outcome.entry);
      return outcome.entry;
    }
    if (outcome.entry === null) {
      patch((plans) => plans.filter((p) => p.id !== entry.id));
      toast("Someone deleted this entry.");
    } else {
      put(outcome.entry);
      toast("Someone else changed this entry. You're seeing their version.");
    }
    return null;
  }

  async function create(draft: EntryDraft, extra?: { repeat: RepeatRule | null; reminders: number[] }): Promise<CalendarEntry | null> {
    try {
      let created = await api.createEntry({ draft, repeat: extra?.repeat ?? null, timeZone, rejoin: null });
      if (extra !== undefined && extra.reminders.length > 0) created = await api.setReminders(created.id, extra.reminders, "all");
      put(created);
      settle();
      return created;
    } catch (error) {
      toast.error(message(error, "We couldn't add that entry."));
      return null;
    }
  }

  async function save(entry: CalendarEntry, draft: EntryDraft, how: { ask: "always" | "once" } = { ask: "once" }): Promise<CalendarEntry | null> {
    const scope = await scopeFor(entry, how);
    if (scope === null) return null;
    patch((plans) => plans.map((p) => (p.id === entry.id ? { ...p, title: draft.title.trim(), notes: draft.notes, when: draft.when } : p)));
    return queued(entry.id, async () => {
      const base = latest.current.get(entry.id) ?? entry;
      try {
        const saved = landed(entry, await api.saveEntry(entry.id, draft, base.updatedAt, scope));
        if (scope === "all") forgetSeries(entry);
        return saved;
      } catch (error) {
        toast.error(message(error, "We couldn't save that entry."));
        return null;
      } finally {
        settle();
      }
    });
  }

  function repeat(entry: CalendarEntry, rule: RepeatRule | null): Promise<CalendarEntry | null> {
    return queued(entry.id, async () => {
      const base = latest.current.get(entry.id) ?? entry;
      try {
        const saved = landed(entry, await api.setRepeat(entry.id, rule, base.updatedAt, timeZone));
        forgetSeries(entry);
        return saved;
      } catch (error) {
        toast.error(message(error, "We couldn't change how it repeats."));
        return null;
      } finally {
        settle();
      }
    });
  }

  async function remind(entry: CalendarEntry, minutes: number[]): Promise<CalendarEntry | null> {
    const scope = await scopeFor(entry, { ask: "once" });
    if (scope === null) return null;
    put({ ...entry, reminders: [...minutes].sort((a, b) => a - b) });
    return queued(entry.id, async () => {
      try {
        const saved = await api.setReminders(entry.id, minutes, scope);
        put(saved);
        return saved;
      } catch (error) {
        toast.error(message(error, "We couldn't set that reminder."));
        return null;
      } finally {
        settle();
      }
    });
  }

  // Undo puts back what was deleted: an occurrence on its day in its series, or the whole
  // series from its first day by its rule.
  async function restore(entry: CalendarEntry, scope: ChangeScope) {
    const draft = draftOf(entry);
    const rep = entry.repeat;
    try {
      let back =
        rep === null || scope === "one"
          ? await api.createEntry({ draft, repeat: null, timeZone, rejoin: rep === null ? null : { seriesId: rep.seriesId, occurrenceOn: rep.occurrenceOn } })
          : await api.createEntry({
              draft: { ...draft, when: shiftWhen(entry.when, { days: daysBetween(rep.occurrenceOn, rep.firstOn), minutes: 0 }, timeZone) },
              repeat: rep.rule,
              timeZone,
              rejoin: null,
            });
      if (entry.reminders.length > 0) back = await api.setReminders(back.id, entry.reminders, scope);
      put(back);
    } catch (error) {
      toast.error(message(error, "We couldn't put that entry back."));
    }
    settle();
  }

  async function remove(entry: CalendarEntry, scope: ChangeScope): Promise<void> {
    const seriesId = entry.repeat?.seriesId;
    const all = scope === "all" && seriesId !== undefined;
    patch((plans) => plans.filter((p) => (all ? p.repeat?.seriesId !== seriesId : p.id !== entry.id)));
    try {
      await queued(entry.id, () => api.deleteEntry(entry.id, scope));
      const what = all ? `${entry.repeat?.count ?? "all"} of “${entry.title}”` : `“${entry.title}”`;
      toast(`Deleted ${what}`, { action: { label: "Undo", onClick: () => void restore(entry, scope) } });
    } catch (error) {
      toast.error(message(error, "We couldn't delete that entry."));
    }
    settle();
  }

  return { create, save, repeat, remind, remove };
}
