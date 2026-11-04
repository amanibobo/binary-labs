import type { Correction, FileLabel, Label } from "@/lib/domain";
import { CorrectionId, type Sha256 } from "@/lib/ids";
import { optimisticLabel, sameLabel, type LabelDraft } from "@/lib/label-edit";

// correct_label, undo_correction and file_labels in memory, with the database's rules,
// for the fixture pages. A file in `later` gains its label on its second poll.
export function createFixtureLabels({ initial, later }: { initial: readonly { sha256: Sha256; label: Label | null }[]; later: Record<string, Label> }) {
  const labels = new Map<Sha256, Label>();
  for (const { sha256, label } of initial) if (label !== null) labels.set(sha256, label);
  const polls = new Map<Sha256, number>();
  const corrections = new Map<number, { sha256: Sha256; before: Label; after: Label; undone: boolean }>();
  let nextId = 1;

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
    correct: (sha256: Sha256, draft: LabelDraft): Correction => {
      const before = labels.get(sha256);
      if (before === undefined) throw new Error("This file doesn't have a label yet.");
      const after = optimisticLabel(before, draft);
      labels.set(sha256, after);
      const id = nextId++;
      corrections.set(id, { sha256, before, after, undone: false });
      return { correctionId: CorrectionId.parse(id), label: after };
    },
    undo: (id: CorrectionId): Correction => {
      const correction = corrections.get(id);
      if (correction === undefined) throw new Error("There's nothing to undo.");
      if (correction.undone) throw new Error("That change was already undone.");
      if (!sameLabel(labels.get(correction.sha256) ?? null, correction.after)) {
        throw new Error("The label changed since, so that undo no longer applies.");
      }
      correction.undone = true;
      labels.set(correction.sha256, correction.before);
      return { correctionId: CorrectionId.parse(nextId++), label: correction.before };
    },
  };
}
