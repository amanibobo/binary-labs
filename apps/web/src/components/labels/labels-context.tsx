"use client";

import { useQuery } from "@tanstack/react-query";
import { createContext, use, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { FileHit, FileLabel, Label, NoteInfo } from "@/lib/domain";
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
