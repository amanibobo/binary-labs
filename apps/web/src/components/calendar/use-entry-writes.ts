"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";
import { draftOf, type CalendarEntry, type EntryDraft, type RangeResponse } from "@/lib/calendar";
import { useCalendarApi } from "./calendar-api";
import type { EntryWrites } from "./entry-peek";

// Writes go on screen at once and to the server one at a time per entry, each based on the
// version the last one returned, so a drag and a quick edit never trip over each other.
export function useEntryWrites(): EntryWrites {
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

  async function create(draft: EntryDraft): Promise<CalendarEntry | null> {
    try {
      const created = await api.createEntry(draft);
      put(created);
      settle();
      return created;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't add that entry.");
      return null;
    }
  }

  function save(entry: CalendarEntry, draft: EntryDraft): Promise<CalendarEntry | null> {
    patch((plans) => plans.map((p) => (p.id === entry.id ? { ...p, title: draft.title.trim(), notes: draft.notes, when: draft.when } : p)));
    return queued(entry.id, async () => {
      const base = latest.current.get(entry.id) ?? entry;
      try {
        const outcome = await api.saveEntry(entry.id, draft, base.updatedAt);
        if (outcome.kind === "saved") {
          put(outcome.entry);
          settle();
          return outcome.entry;
        }
        if (outcome.entry === null) {
          patch((plans) => plans.filter((p) => p.id !== entry.id));
          toast("Someone deleted this entry.");
        } else {
          put(outcome.entry);
          toast("Someone else changed this entry. You're seeing their version.");
        }
        settle();
        return null;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "We couldn't save that entry.");
        settle();
        return null;
      }
    });
  }

  async function remove(entry: CalendarEntry): Promise<void> {
    patch((plans) => plans.filter((p) => p.id !== entry.id));
    try {
      await queued(entry.id, () => api.deleteEntry(entry.id));
      toast(`Deleted “${entry.title}”`, { action: { label: "Undo", onClick: () => void create(draftOf(entry)) } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't delete that entry.");
    }
    settle();
  }

  return { create, save, remove };
}
