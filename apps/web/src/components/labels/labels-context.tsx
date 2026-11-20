"use client";

import { useQuery } from "@tanstack/react-query";
import { createContext, use, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { planBulk, undoLine, type BatchId, type BulkChange, type BulkPlan } from "@/lib/bulk-labels";
import type { FileHit, FileLabel, FileRef, Label, NoteInfo } from "@/lib/domain";
import type { Sha256 } from "@/lib/ids";
import { MAX_POLLED_SHAS } from "@/lib/labels";
import {
  applyEdit,
  draftOf,
  needsLookDelta,
  optimisticLabel,
  revertTarget,
  sameLabel,
  undoTarget,
  type LabelDraft,
  type LabelEdit,
  type LabLists,
  type UndoEntry,
} from "@/lib/label-edit";
import { useLabApi } from "../lab-api";
import { useNeedsLookCount } from "./needs-look-count";

const LabListsContext = createContext<LabLists>({ experiments: [], people: [] });

export function LabListsProvider({ value, children }: { value: LabLists; children: ReactNode }) {
  return <LabListsContext value={value}>{children}</LabListsContext>;
}

export function useLabLists(): LabLists {
  return use(LabListsContext);
}

export type EditOutcome = { kind: "saved" } | { kind: "invalid"; message: string };

type Labels = {
  // Labels learned on this page (edits, undos, polls) win over what the page loaded.
  labelOf: (hit: LabeledFile) => Label | null;
  edit: (hit: LabeledFile, edit: LabelEdit, message: string) => EditOutcome;
  accept: (hit: LabeledFile) => void;
  merge: (labels: readonly FileLabel[]) => void;
  // After a note is kept, split or loses a page, the row shows it before the next load.
  setNote: (hit: LabeledFile, note: NoteInfo | null) => void;
  // One change to many files at once, undone together from its toast. Returns what it changed.
  editMany: (hits: readonly LabeledFile[], change: BulkChange, title: string) => BulkPlan;
  // Stops asking a voice note's question; the toast's Undo asks it again.
  skipQuestion: (hit: LabeledFile) => void;
  // Links a repeat run to the run it repeats, or unlinks it (null); the toast undoes it.
  linkRepeat: (hit: LabeledFile, repeatOf: FileRef | null) => void;
};

// What labels need of a file: its hash and the label it was loaded with. A search hit is one;
// so is a talk-through's recording.
export type LabeledFile = Pick<FileHit, "sha256" | "label">;

const LabelsContext = createContext<Labels | null>(null);

export function useLabels(): Labels {
  const labels = use(LabelsContext);
  if (labels === null) throw new Error("useLabels needs a LabelsProvider");
  return labels;
}

export function LabelsProvider({ children }: { children: ReactNode }) {
  const api = useLabApi();
  const lists = useLabLists();
  const needsLook = useNeedsLookCount();
  const [learned, setLearned] = useState<ReadonlyMap<Sha256, Label>>(new Map());
  // Async callbacks read and write through the ref; renders read the state.
  const current = useRef(learned);
  const queues = useRef(new Map<Sha256, Promise<void>>());

  const showing = (sha: Sha256, fallback: Label | null) => current.current.get(sha) ?? fallback;

  function write(sha: Sha256, next: Label, fallback: Label | null) {
    needsLook.shift(needsLookDelta(showing(sha, fallback), next));
    current.current = new Map(current.current).set(sha, next);
    setLearned(current.current);
  }

  // One request at a time per file, so a quick second edit can't land before the first.
  function enqueue(sha: Sha256, task: () => Promise<void>) {
    const next = (queues.current.get(sha) ?? Promise.resolve()).then(task, task);
    queues.current.set(sha, next);
  }

  function undo(entry: UndoEntry) {
    const target = undoTarget(entry, showing(entry.sha256, null));
    if (target === null) {
      toast.error("The label changed since, so that can't be undone.");
      return;
    }
    write(entry.sha256, target, null);
    enqueue(entry.sha256, async () => {
      try {
        const restored = await api.undoCorrection(entry.correctionId);
        write(entry.sha256, restored.label, null);
        toast("Change undone");
      } catch (error) {
        if (sameLabel(showing(entry.sha256, null), target)) write(entry.sha256, entry.after, null);
        toast.error(error instanceof Error ? error.message : "We couldn't undo that.");
      }
    });
  }

  function save(hit: LabeledFile, before: Label, draft: LabelDraft, message: string) {
    const optimistic = optimisticLabel(before, draft);
    write(hit.sha256, optimistic, hit.label);
    enqueue(hit.sha256, async () => {
      try {
        const saved = await api.correctLabel(hit.sha256, draft);
        if (sameLabel(showing(hit.sha256, null), optimistic)) write(hit.sha256, saved.label, null);
        const entry: UndoEntry = { correctionId: saved.correctionId, sha256: hit.sha256, before, after: saved.label };
        toast(message, { action: { label: "Undo", onClick: () => undo(entry) } });
      } catch (error) {
        const back = revertTarget({ showing: showing(hit.sha256, null), optimistic, before });
        if (back !== null) write(hit.sha256, back, null);
        toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
      }
    });
  }

  function undoMany(batchId: BatchId, entries: readonly UndoEntry[]) {
    const targets = entries.flatMap((e) => {
      const target = undoTarget(e, showing(e.sha256, null));
      return target === null ? [] : [{ entry: e, target }];
    });
    for (const { entry, target } of targets) write(entry.sha256, target, null);
    void (async () => {
      try {
        const result = await api.undoLabelBatch(batchId);
        for (const u of result.undone) write(u.sha256, u.label, null);
        // Files changed since keep what the server has; put back what this undo assumed.
        const undone = new Set(result.undone.map((u) => u.sha256));
        for (const { entry, target } of targets) {
          if (!undone.has(entry.sha256) && sameLabel(showing(entry.sha256, null), target)) write(entry.sha256, entry.after, null);
        }
        toast(undoLine(result));
      } catch (error) {
        for (const { entry, target } of targets) if (sameLabel(showing(entry.sha256, null), target)) write(entry.sha256, entry.after, null);
        toast.error(error instanceof Error ? error.message : "We couldn't undo that.");
      }
    })();
  }

  // The other runs a link touches show it too: their labels come back from the server.
  async function refresh(shas: readonly Sha256[]) {
    if (shas.length === 0) return;
    const found = await api.fileLabels(shas, new AbortController().signal).catch(() => []);
    for (const { sha256, label } of found) write(sha256, label, null);
  }

  const labels: Labels = {
    labelOf: (hit) => learned.get(hit.sha256) ?? hit.label,
    edit: (hit, edit, message) => {
      const before = showing(hit.sha256, hit.label);
      if (before === null) return { kind: "invalid", message: "This file doesn't have a label yet." };
      const result = applyEdit({ label: before, edit, lists });
      switch (result.kind) {
        case "invalid":
          return result;
        case "unchanged":
          return { kind: "saved" };
        case "changed":
          save(hit, before, result.draft, message);
          return { kind: "saved" };
        default: {
          const _exhaustive: never = result;
          return _exhaustive;
        }
      }
    },
    accept: (hit) => {
      const before = showing(hit.sha256, hit.label);
      const draft = before === null ? null : draftOf(before);
      if (before === null || draft === null) return;
      save(hit, before, draft, "Marked as right");
    },
    setNote: (hit, note) => {
      const before = showing(hit.sha256, hit.label);
      if (before !== null) write(hit.sha256, { ...before, note }, hit.label);
    },
    editMany: (hits, change, title) => {
      const items = hits.map((hit) => ({ sha256: hit.sha256, label: showing(hit.sha256, hit.label) }));
      const plan = planBulk(items, change);
      if (plan.changes.length === 0) return plan;
      const fallback = new Map(hits.map((h) => [h.sha256, h.label]));
      const optimistic = plan.changes.map((c) => ({ ...c, optimistic: optimisticLabel(c.before, c.draft) }));
      for (const c of optimistic) write(c.sha256, c.optimistic, fallback.get(c.sha256) ?? null);
      const revert = () => {
        for (const c of optimistic) {
          const back = revertTarget({ showing: showing(c.sha256, null), optimistic: c.optimistic, before: c.before });
          if (back !== null) write(c.sha256, back, null);
        }
      };
      void (async () => {
        try {
          const saved = await api.correctLabels(
            optimistic.map((c) => c.sha256),
            change,
          );
          const bySha = new Map(saved.changed.map((c) => [c.sha256, c]));
          const entries: UndoEntry[] = [];
          for (const c of optimistic) {
            const got = bySha.get(c.sha256);
            if (got === undefined) {
              // The server found it already changed; show what it has.
              const back = revertTarget({ showing: showing(c.sha256, null), optimistic: c.optimistic, before: c.before });
              if (back !== null) write(c.sha256, back, null);
              continue;
            }
            if (sameLabel(showing(c.sha256, null), c.optimistic)) write(c.sha256, got.label, null);
            entries.push({ correctionId: got.correctionId, sha256: c.sha256, before: c.before, after: got.label });
          }
          const batchId = saved.batchId;
          const count = entries.length === 1 ? "1 file" : `${entries.length} files`;
          if (batchId === null) toast("Nothing needed changing");
          else toast(`${title} on ${count}`, { action: { label: "Undo", onClick: () => undoMany(batchId, entries) } });
        } catch (error) {
          revert();
          toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
        }
      })();
      return plan;
    },
    skipQuestion: (hit) => {
      const before = showing(hit.sha256, hit.label);
      if (before === null || before.followUp === null) return;
      const optimistic = { ...before, followUp: null };
      write(hit.sha256, optimistic, hit.label);
      const ask = (skipped: boolean, message: string) =>
        enqueue(hit.sha256, async () => {
          try {
            const label = await api.skipQuestion(hit.sha256, skipped);
            write(hit.sha256, label, null);
            if (skipped) toast(message, { action: { label: "Undo", onClick: () => ask(false, "") } });
          } catch (error) {
            if (skipped && sameLabel(showing(hit.sha256, null), optimistic)) write(hit.sha256, before, null);
            toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
          }
        });
      ask(true, "Question skipped");
    },
    linkRepeat: (hit, repeatOf) => {
      const before = showing(hit.sha256, hit.label);
      if (before === null || before.repeatOf?.sha256 === repeatOf?.sha256) return;
      const previous = before.repeatOf;
      write(hit.sha256, { ...before, repeatOf }, hit.label);
      // `from` is what the file was linked to before; both runs' labels change.
      const link = (to: FileRef | null, from: FileRef | null, offerUndo: boolean) =>
        enqueue(hit.sha256, async () => {
          try {
            const label = await api.linkRepeat(hit.sha256, to?.sha256 ?? null);
            write(hit.sha256, label, null);
            await refresh([to?.sha256, from?.sha256].filter((s): s is Sha256 => s !== undefined));
            if (offerUndo) {
              const message = to === null ? "Link removed" : `Linked to “${to.name}”`;
              toast(message, { action: { label: "Undo", onClick: () => link(from, to, false) } });
            }
          } catch (error) {
            const now = showing(hit.sha256, null);
            if (now !== null && now.repeatOf?.sha256 === to?.sha256) write(hit.sha256, { ...now, repeatOf: from }, null);
            toast.error(error instanceof Error ? error.message : "We couldn't save that. Try again.");
          }
        });
      link(repeatOf, previous, true);
    },
    merge: (polled) => {
      for (const { sha256, label } of polled) {
        if (!current.current.has(sha256)) write(sha256, label, null);
      }
    },
  };

  return <LabelsContext value={labels}>{children}</LabelsContext>;
}

export const LABEL_POLL_MS = 2000;

// Files on screen that the labeler hasn't reached yet get their labels as they land.
export function useLabelPolling(hits: readonly FileHit[]) {
  const api = useLabApi();
  const { labelOf, merge } = useLabels();
  const missing = hits.filter((hit) => labelOf(hit) === null).map((hit) => hit.sha256)
    .slice(0, MAX_POLLED_SHAS);
  useQuery({
    queryKey: ["file-labels", missing],
    queryFn: async ({ signal }) => {
      const found = await api.fileLabels(missing, signal);
      merge(found);
      return found;
    },
    enabled: missing.length > 0,
    refetchInterval: missing.length > 0 ? LABEL_POLL_MS : false,
  });
}
