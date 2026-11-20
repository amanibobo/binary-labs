import { BatchId, planBulk, type BulkChange, type BulkResult, type UndoBatchResult } from "@/lib/bulk-labels";
import type { Correction, FileLabel, FollowUp, Label } from "@/lib/domain";
import { CorrectionId, type Sha256 } from "@/lib/ids";
import { optimisticLabel, sameLabel, type LabelDraft } from "@/lib/label-edit";
import type { RepeatCandidate } from "@/lib/labels";

// correct_label, undo_correction, file_labels, correct_labels, undo_label_batch, skip_follow_up,
// link_repeat and repeat_candidates in memory, with the database's rules, for the fixture
// pages. A file in `later` gains its label on its second poll.
export function createFixtureLabels({ initial, later }: { initial: readonly { sha256: Sha256; label: Label | null }[]; later: Record<string, Label> }) {
  const labels = new Map<Sha256, Label>();
  for (const { sha256, label } of initial) if (label !== null) labels.set(sha256, label);
  const polls = new Map<Sha256, number>();
  const corrections = new Map<number, { sha256: Sha256; before: Label; after: Label; undone: boolean }>();
  let nextId = 1;
  const batches = new Map<string, number[]>();
  const skipped = new Map<Sha256, FollowUp>();

  const correct = (sha256: Sha256, draft: LabelDraft): Correction => {
    const before = labels.get(sha256);
    if (before === undefined) throw new Error("This file doesn't have a label yet.");
    const after = optimisticLabel(before, draft);
    labels.set(sha256, after);
    const id = nextId++;
    corrections.set(id, { sha256, before, after, undone: false });
    return { correctionId: CorrectionId.parse(id), label: after };
  };
  const undo = (id: CorrectionId): Correction => {
    const correction = corrections.get(id);
    if (correction === undefined) throw new Error("There's nothing to undo.");
    if (correction.undone) throw new Error("That change was already undone.");
    if (!sameLabel(labels.get(correction.sha256) ?? null, correction.after)) {
      throw new Error("The label changed since, so that undo no longer applies.");
    }
    correction.undone = true;
    labels.set(correction.sha256, correction.before);
    return { correctionId: CorrectionId.parse(nextId++), label: correction.before };
  };
  const update = (sha: Sha256, f: (l: Label) => Label) => {
    const label = labels.get(sha);
    if (label !== undefined) labels.set(sha, f(label));
  };

  return {
    get: (sha: Sha256): Label | null => labels.get(sha) ?? null,
    poll: (shas: readonly Sha256[]): FileLabel[] =>
      shas.flatMap((sha256) => {
        const pending = later[sha256];
        if (!labels.has(sha256) && pending !== undefined) {
          const count = (polls.get(sha256) ?? 0) + 1;
          polls.set(sha256, count);
          if (count >= 2) labels.set(sha256, pending);
        }
        const label = labels.get(sha256);
        return label === undefined ? [] : [{ sha256, label }];
      }),
    correct,
    undo,
    correctMany: (shas: readonly Sha256[], change: BulkChange): BulkResult => {
      const plan = planBulk(shas.map((sha256) => ({ sha256, label: labels.get(sha256) ?? null })), change);
      const changed = plan.changes.map(({ sha256, draft }) => ({ sha256, ...correct(sha256, draft) }));
      const batchId = changed.length === 0 ? null : BatchId.parse(crypto.randomUUID());
      if (batchId !== null) batches.set(batchId, changed.map((c) => c.correctionId));
      return { batchId, changed, same: plan.same, unnamed: plan.unnamed, full: plan.full };
    },
    undoBatch: (batchId: BatchId): UndoBatchResult => {
      const ids = batches.get(batchId);
      if (ids === undefined) throw new Error("There's nothing to undo.");
      const result: UndoBatchResult = { undone: [], skipped: 0 };
      for (const id of ids) {
        try {
          const sha256 = corrections.get(id)?.sha256;
          const undone = undo(CorrectionId.parse(id));
          if (sha256 !== undefined) result.undone.push({ sha256, ...undone });
        } catch {
          result.skipped += 1;
        }
      }
      return result;
    },
    skip: (sha: Sha256, skip: boolean): Label => {
      const label = labels.get(sha);
      if (label === undefined) throw new Error("This file doesn't have a label yet.");
      const question = skip ? label.followUp : (skipped.get(sha) ?? null);
      if (skip && question !== null) skipped.set(sha, question);
      if (!skip) skipped.delete(sha);
      const next = { ...label, followUp: skip ? null : question };
      labels.set(sha, next);
      return next;
    },
    link: (sha: Sha256, repeatOf: Sha256 | null): Label => {
      const label = labels.get(sha);
      if (label === undefined || label.cleanName === null) throw new Error("Pick a labeled file from this lab.");
      const target = repeatOf === null ? null : labels.get(repeatOf);
      if (target === undefined || target?.cleanName === null || repeatOf === sha) throw new Error("Pick a labeled file from this lab.");
      const me = { sha256: sha, name: label.cleanName };
      if (label.repeatOf !== null) update(label.repeatOf.sha256, (l) => ({ ...l, repeatedIn: l.repeatedIn.filter((r) => r.sha256 !== sha) }));
      if (repeatOf !== null) update(repeatOf, (l) => ({ ...l, repeatedIn: [...l.repeatedIn, me] }));
      const next = { ...label, repeatOf: repeatOf === null || target === null ? null : { sha256: repeatOf, name: target.cleanName } };
      labels.set(sha, next);
      return next;
    },
    candidates: (sha: Sha256, query: string): RepeatCandidate[] => {
      const me = labels.get(sha);
      const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
      const sameExperiment = (l: Label) => l.experiment !== null && l.experiment.id === me?.experiment?.id;
      return [...labels.entries()]
        .filter(([sha256, l]) => sha256 !== sha && l.cleanName !== null && l.repeatOf?.sha256 !== sha && words.every((w) => l.cleanName?.toLowerCase().includes(w)))
        .toSorted(([, a], [, b]) => Number(sameExperiment(b)) - Number(sameExperiment(a)) || (b.date ?? "").localeCompare(a.date ?? ""))
        .slice(0, 8)
        .map(([sha256, l]) => ({ sha256, name: l.cleanName ?? "", date: l.date, experiment: l.experiment?.name ?? null, outcome: l.outcome }));
    },
  };
}
