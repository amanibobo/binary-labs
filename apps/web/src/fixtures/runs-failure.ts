import type { FailureApi } from "@/components/runs/api/failure";
import { UserId } from "@/lib/ids";
import { FailureList, type ConfirmerChoice } from "@/lib/run-failure";
import type { FailureFields, RunRecord } from "@/lib/run-record";
import { members, people } from "./data";
import type { FixtureRunStore } from "./runs";

// Slice A's fixture twin: the failure record over the page's own copy of the runs. The viewer
// is Priya Nair, so a cause naming her shows "Yes, I confirmed this".

const priyaUser = UserId.parse(members[1]?.userId);

const term = (code: string, label: string, position: number, hint: string | null = null) => ({ version: 1, code, label, hint, position });

const TECHNIQUES = [
  ["pcr", "PCR"], ["qpcr", "qPCR or RT-qPCR"], ["cloning", "Cloning or assembly"], ["transformation", "Transformation"],
  ["nucleic_prep", "DNA or RNA prep"], ["dna_gel", "DNA or RNA gel"], ["sequencing", "Sequencing"],
  ["protein_prep", "Protein expression or purification"], ["protein_gel", "Protein gel (SDS-PAGE)"], ["western", "Western blot"],
  ["protein_assay", "Protein amount assay (Bradford, BCA)"], ["elisa", "ELISA"], ["enzyme_assay", "Enzyme or activity assay"],
  ["cell_culture", "Cell culture"], ["transfection", "Transfection or transduction"], ["viability", "Cell viability or dose-response"],
  ["flow", "Flow cytometry"], ["microscopy", "Microscopy or imaging"], ["staining", "Immunostaining"],
  ["microbial_growth", "Bacterial or yeast growth"], ["other", "Something else"],
] as const;

// Version 1 as 0034 seeds it, for the fixture pages only; the app reads the database's.
export const fixtureFailureList: FailureList = FailureList.parse({
  version: 1,
  signedOffAt: null,
  signedOffBy: null,
  terms: [
    ...TECHNIQUES.map(([code, label], i) => term(`tech.${code}`, label, i + 1)),
    term("step.planning", "Planning", 1, "The design, the controls chosen, the maths"),
    term("step.reagent_prep", "Making reagents", 2, "Buffers, media, dilutions, stocks"),
    term("step.sample_prep", "Preparing samples", 3, "Extraction, lysis, counting cells"),
    term("step.setup", "Setting up", 4, "Pipetting, loading, plating"),
    term("step.run", "The run itself", 5, "Incubation, cycling, time on the machine"),
    term("step.handling", "Between steps", 6, "Washes, transfers, waiting"),
    term("step.measurement", "Measuring", 7, "The read, the image, the scan"),
    term("step.analysis", "Analysing the data", 8, "Formulas, software, gating"),
    term("step.storage", "Storage", 9, "Before or after the run"),
    term("step.unknown", "Not known yet", 10),
    term("cause.reagent", "A reagent was bad", 1, "Expired, degraded, wrong lot"),
    term("cause.amount", "Wrong amount or concentration", 2, "A slip in pipetting or a calculation"),
    term("cause.sample", "The sample was the problem", 3, "Degraded, too little, poor quality"),
    term("cause.mix_up", "Labels or tubes mixed up", 4),
    term("cause.contamination", "Contamination", 5),
    term("cause.equipment", "An instrument or tool", 6, "Fault, calibration, wrong setting"),
    term("cause.conditions", "Time or temperature was off", 7),
    term("cause.step_missed", "A step was missed or changed", 8),
    term("cause.protocol", "The protocol doesn't work for this", 9, "It was followed and still failed"),
    term("cause.analysis", "A mistake in the analysis", 10),
    term("cause.biology", "A real result, not a mistake", 11, "The biology did something unexpected"),
    term("cause.unknown", "Not known", 12),
    term("cause.other", "Something else", 13),
  ],
});


const choices: ConfirmerChoice[] = people.map((p, i) => ({ id: p.id, name: p.name, you: i === 1, account: i !== 2 }));

const NO_CONFIRMATION = {
  confirmedCause: null,
  confirmedBy: null,
  confirmMethod: null,
  confirmNote: null,
  confirmRun: null,
  confirmSha256: null,
  confirmedAt: null,
  confirmRecordedBy: null,
  confirmerAttestedAt: null,
} satisfies Partial<FailureFields>;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function wentWrong(run: RunRecord): void {
  if (run.status !== "failed" && run.status !== "odd") throw new Error("A cause goes on a run that failed or was odd. Mark it Failed or Odd first.");
}

export const fixtureFailureApi = (store: FixtureRunStore): FailureApi => {
  const update = (run: RunRecord, failure: Partial<FailureFields>) => store.put({ ...run, failure: { ...run.failure, ...failure } });
  return {
    failureList: async () => fixtureFailureList,
    confirmerChoices: async () => {
      await wait(60);
      return choices;
    },
    setSuspectedCause: async (id, cause) => {
      await wait(120);
      const run = store.get(id);
      const text = cause?.trim() ?? "";
      if (text !== "") wentWrong(run);
      return update(run, { suspectedCause: text === "" ? null : text, suspectedBy: text === "" ? null : priyaUser });
    },
    confirmCause: async (id, draft) => {
      await wait(150);
      const run = store.get(id);
      wentWrong(run);
      const person = choices.find((c) => c.id === draft.personId);
      if (person === undefined) throw new Error("That person isn't in this lab's People. Add them in Settings, then pick them.");
      const at = draft.confirmedAt ?? new Date().toISOString();
      if (Date.parse(at) > Date.now() + 300_000) throw new Error("That time is in the future. Pick when it was confirmed.");
      const { evidence } = draft;
      if (evidence.method === "control" && !run.files.some((f) => f.sha256 === evidence.sha256)) throw new Error("That doesn't fit how it was confirmed.");
      const repeat = evidence.method === "repeat" && evidence.runId !== null ? store.get(evidence.runId) : null;
      return update(run, {
        confirmedCause: draft.cause,
        confirmedBy: { id: person.id, name: person.name },
        confirmMethod: evidence.method,
        confirmNote: draft.note === null || draft.note === "" ? null : draft.note,
        confirmRun: repeat === null ? null : { id: repeat.id, title: repeat.title, startedOn: repeat.startedOn, status: repeat.status },
        confirmSha256: evidence.method === "control" ? evidence.sha256 : null,
        confirmedAt: at,
        confirmRecordedBy: priyaUser,
        confirmerAttestedAt: person.you ? new Date().toISOString() : null,
      });
    },
    withdrawCause: async (id) => {
      await wait(120);
      return update(store.get(id), NO_CONFIRMATION);
    },
    attestCause: async (id) => {
      await wait(120);
      const run = store.get(id);
      const mine = choices.find((c) => c.you);
      if (run.failure.confirmedBy === null || run.failure.confirmedBy.id !== mine?.id) throw new Error("Only the person named as the confirmer can say yes, from their own account.");
      return update(run, { confirmerAttestedAt: run.failure.confirmerAttestedAt ?? new Date().toISOString() });
    },
    setFailureType: async (id, type) => {
      await wait(120);
      const run = store.get(id);
      const empty = type === null || (type.technique === null && type.failedStep === null && type.causeCategory === null);
      if (!empty) wentWrong(run);
      return update(run, {
        taxonomyVersion: empty ? null : type.version,
        technique: type?.technique ?? null,
        failedStep: type?.failedStep ?? null,
        causeCategory: type?.causeCategory ?? null,
      });
    },
  };
};
