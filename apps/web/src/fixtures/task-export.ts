import type { ExportApi } from "@/components/runs/export/export-api";
import { PersonId, Sha256, UserId, type RunId } from "@/lib/ids";
import type { RunRecord } from "@/lib/run-record";
import type { ExportReason, PersonChoice, RunTask, TaskSource } from "@/lib/task-export";
import { buildTaskFolder, previewOf } from "@/lib/task-folder";
import { members, people } from "./data";
import { FIRST_TRY, fixtureRuns } from "./runs";

// Dev-only screenshot data for the task page: the first BM3 try, failed, its cause confirmed
// by Jordan. The record shown with names taken out is made by the real de-identifier from
// the source below, so what the screenshots show is what a build would write. SAMPLE data.

const [ade, priya, jordan] = people;
const [adeUser, priyaUser, jordanUser] = members.map((m) => UserId.parse(m.userId));
const sha = (n: number) => Sha256.parse(String(n).repeat(64).slice(0, 64));
const CSV = "lane,sample,operator,band_kDa\n1,PN-042 uninduced,Priya Nair,\n2,PN-042 induced 4 h,Priya Nair,\n3,ladder,,119\n";

if (ade === undefined || priya === undefined || jordan === undefined || adeUser === undefined || priyaUser === undefined || jordanUser === undefined) throw new Error("the task fixture needs the lab fixture's people");

const base = fixtureRuns.find((r) => r.id === FIRST_TRY);
if (base === undefined) throw new Error("the task fixture needs the first-try run");

export const fixtureTaskRun: RunRecord = {
  ...base,
  failure: {
    ...base.failure,
    suspectedCause: "Priya thought the IPTG stock was old.",
    confirmedCause: "The IPTG stock had gone off. Jordan repeated the induction with a fresh stock and BM3 expressed.",
    confirmedBy: { id: jordan.id, name: jordan.name },
    confirmMethod: "repeat",
    confirmedAt: "2026-10-16T15:40:00Z",
    confirmRecordedBy: priyaUser,
    confirmerAttestedAt: "2026-10-16T16:05:00Z",
  },
};

export const fixturePeople: PersonChoice[] = people.map((p) => ({ id: p.id, name: p.name }));
export const fixtureMe = PersonId.parse(jordan.id);

const source: TaskSource = {
  run: {
    id: FIRST_TRY,
    title: "BM3 expression, first try (Priya)",
    startedOn: "2026-10-14",
    endedOn: "2026-10-15",
    status: "failed",
    statusBy: priyaUser,
    statusAt: "2026-10-15T17:02:00Z",
    experiment: "P450 BM3 expression",
    personId: priya.id,
    retryOf: null,
    suspectedCause: fixtureTaskRun.failure.suspectedCause,
    confirmedCause: fixtureTaskRun.failure.confirmedCause,
    confirmedBy: jordan.id,
    confirmMethod: "repeat",
    confirmNote: "Repeat run by JM on 16 October, same cells, fresh IPTG.",
    confirmRun: null,
    confirmSha256: null,
    confirmedAt: "2026-10-16T15:40:00Z",
    confirmRecordedBy: priyaUser,
    confirmerAttestedAt: "2026-10-16T16:05:00Z",
    taxonomyVersion: 1,
    technique: { code: "tech.protein_expression", label: "Protein expression" },
    failedStep: { code: "step.induction", label: "Induction" },
    causeCategory: { code: "cause.reagent", label: "A reagent" },
    aim: "Express P450 BM3 in BL21 for the Okafor lab's activity assays.",
    expectedSeen: "A strong band at 119 kDa after induction. Priya saw no band in the induced lane.",
    howFound: "Jordan Morales re-ran the induction with a new IPTG stock.",
    whatChanged: "Fresh IPTG, made that morning.",
    fixWorked: "yes",
    whoElse: "Ade Okafor saw the repeat gel.",
    asRunBody: "1. Grow BL21 to OD600 0.9 (planned 0.6; PN was at a seminar).\n2. Induce with 0.5 mM IPTG from the shared stock.\n3. 4 h at 30 °C, then lyse and run on a 10% gel.",
    asRunBy: priyaUser,
    asRunAt: "2026-10-15T17:20:00Z",
  },
  planned: { title: "BM3 expression (Okafor lab)", version: 3, body: "1. Grow BL21 to OD600 0.6.\n2. Induce with 0.5 mM IPTG.\n3. 4 h at 30 °C, then lyse and run on a 10% gel.\n\nAsk Priya where the IPTG is." },
  task: null,
  reviews: [],
  files: [
    { sha256: sha(1), role: "evidence", fileKind: "spreadsheet", mime: "text/csv", size: CSV.length, originalName: "Priya_Nair_gel_lanes_2026-10-15.csv", kept: true, paths: ["/Lab/Gels/Priya_Nair_gel_lanes_2026-10-15.csv"] },
    { sha256: sha(2), role: "evidence", fileKind: "image", mime: "image/tiff", size: 4_812_330, originalName: "PN-042 BM3 gel.tif", kept: true, paths: ["/Lab/Gels/PN-042 BM3 gel.tif"] },
    { sha256: sha(3), role: "shared_control", fileKind: "spreadsheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 48_211, originalName: "ladder standards.xlsx", kept: true, paths: ["/Lab/Standards/ladder standards.xlsx"] },
  ],
  log: [
    { at: "2026-10-15T17:00:00Z", action: "run.create", via: "person", actor: priyaUser, changed: ["title"], share: null },
    { at: "2026-10-16T15:40:00Z", action: "run.edit", via: "person", actor: priyaUser, changed: ["confirmed_cause", "confirmed_by"], share: null },
    { at: "2026-10-16T16:05:00Z", action: "run.edit", via: "person", actor: jordanUser, changed: ["confirmer_attested_at"], share: null },
  ],
  people: people.map((p, i) => ({ personId: p.id, userId: UserId.parse(members[i]?.userId), names: [p.name, ...p.aliases], emails: [members[i]?.email ?? ""] })),
  lab: { name: "Okafor lab", demo: false, agreement: "draft-1", agreedAt: "2026-11-05T10:12:00Z", agreedBy: adeUser },
  exclusions: [],
  blocks: [],
  gaps: [],
};

const written = {
  question: "The induced lane shows no band at 119 kDa. What is the most likely reason BM3 did not express?",
  rubric: [
    { criterion: "Names the IPTG stock (the inducer) as the cause", points: 5 },
    { criterion: "Says a repeat with fresh IPTG is what would show it", points: 3 },
    { criterion: "Rules out the late induction (OD 0.9) as enough on its own", points: 2 },
  ],
  review: { reviewer: { id: PersonId.parse(ade.id), name: ade.name }, notes: "Agree. I saw Jordan's repeat gel: same cells, same day, a clear band with the fresh stock.", agrees: true, reviewedAt: "2026-10-17T09:30:00Z" },
};

export type TaskFixtureView = "start" | "written" | "waiting" | "built" | "demo";

const emptyTask: RunTask = { runId: FIRST_TRY, question: null, rubric: [], writtenAt: null, review: null, ranBy: PersonId.parse(priya.id), gaps: ["no_task", "no_review"], blocks: [], demo: false, canExclude: true, exclusions: [], exports: [] };
const writtenTask: RunTask = { ...emptyTask, question: written.question, rubric: written.rubric, writtenAt: "2026-10-17T09:30:00Z", review: written.review, gaps: [] };

export function fixtureTask(view: TaskFixtureView): RunTask {
  switch (view) {
    case "start":
      return emptyTask;
    case "written":
      return writtenTask;
    case "waiting":
      return { ...emptyTask, canExclude: false, blocks: ["run_off", "not_attested"], exclusions: [{ kind: "field", value: "evidence.image" }] };
    case "built":
      return {
        ...writtenTask,
        exports: [
          { id: "3b0f6c1e-2a47-4d1b-9c55-0d1f6a7e0002", builtAt: "2026-11-14T10:05:00Z", withdrawnAt: null, hasFiles: true, files: 3, bytes: 4_866_112 },
          { id: "3b0f6c1e-2a47-4d1b-9c55-0d1f6a7e0001", builtAt: "2026-11-12T14:31:00Z", withdrawnAt: "2026-11-13T08:12:00Z", hasFiles: false, files: 3, bytes: 4_865_904 },
        ],
      };
    case "demo":
      return { ...writtenTask, demo: true, blocks: ["demo_lab"] };
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The task page's API over this page's own copy: writes land here and nowhere else.
export function createFixtureExport(view: TaskFixtureView): ExportApi {
  let task = fixtureTask(view);
  const reasons = (): ExportReason[] => [...task.blocks, ...task.gaps];
  return {
    task: async () => task,
    saveTask: async (_id: RunId, body) => {
      await wait(150);
      const reviewer = fixturePeople.find((p) => p.id === body.reviewerId) ?? null;
      task = { ...task, question: body.question, rubric: body.rubric, writtenAt: new Date().toISOString(), review: { reviewer, notes: body.notes, agrees: body.agrees, reviewedAt: new Date().toISOString() }, gaps: [] };
      return task;
    },
    preview: async () => {
      await wait(150);
      const from: TaskSource = {
        ...source,
        task: task.question === null ? null : { question: task.question, rubric: task.rubric, writtenBy: jordanUser, writtenAt: task.writtenAt ?? "2026-10-17T09:30:00Z" },
        reviews: task.review === null ? [] : [{ reviewerId: task.review.reviewer?.id ?? null, notes: task.review.notes, agrees: task.review.agrees, recordedBy: jordanUser, reviewedAt: task.review.reviewedAt }],
        exclusions: task.exclusions,
        blocks: task.blocks,
        gaps: task.gaps,
      };
      return previewOf(from, buildTaskFolder(from, new Map([[sha(1), new TextEncoder().encode(CSV)]])));
    },
    build: async () => {
      await wait(400);
      if (reasons().length > 0) return { kind: "blocked", reasons: reasons() };
      const id = "3b0f6c1e-2a47-4d1b-9c55-0d1f6a7e0009";
      task = { ...task, exports: [{ id, builtAt: new Date().toISOString(), withdrawnAt: null, hasFiles: true, files: 3, bytes: 4_866_112 }, ...task.exports] };
      return { kind: "built", id, task };
    },
    setExclusion: async (_id, x) => {
      await wait(100);
      const rest = task.exclusions.filter((e) => !(e.kind === x.kind && e.value === x.value));
      task = { ...task, exclusions: x.on ? [...rest, { kind: x.kind, value: x.value }] : rest };
      return task.exclusions;
    },
  };
}
