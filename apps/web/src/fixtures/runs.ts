import type { RunsApi, RunsCoreApi } from "@/components/runs/runs-api";
import type { FileHit } from "@/lib/domain";
import { RunId, UserId, type Sha256 } from "@/lib/ids";
import { RunRecord, RunSuggestion, type RunFile, type RunRef, type RunRow } from "@/lib/run-record";
import { experiments, members, people, recentFiles, searchHits } from "./data";
import { fixtureDebriefApi } from "./runs-debrief";
import { fixtureEvidenceApi } from "./runs-evidence";
import { fixtureFailureApi } from "./runs-failure";
import { fixtureSharingApi } from "./runs-sharing";

// Dev-only screenshot data: three runs of the P450 BM3 work. The first try failed, the second
// is a retry that worked, and the third nobody has marked yet (one of its files has left the
// lab's folder, another is still being saved). Writes land in this page's copy.

const id = (n: number) => RunId.parse(`7d1c2c39-5a4e-4c55-9d7b-0c3c1a7d${String(n).padStart(4, "0")}`);
export const FIRST_TRY = id(1);
export const RETRY = id(2);
export const UNMARKED = id(3);

const [bm3, solubility] = experiments.map((e) => ({ id: e.id, name: e.name }));
const [, priya, jordan] = people.map((p) => ({ id: p.id, name: p.name }));
const priyaUser = UserId.parse(members[1]?.userId);

function fileOf(hit: FileHit | undefined, extra: Partial<RunFile> = {}): RunFile {
  if (hit === undefined) throw new Error("the runs fixture needs the search fixture's files");
  const place = hit.locations[0];
  return {
    sha256: hit.sha256,
    role: "evidence",
    name: hit.label?.cleanName ?? place.originalName,
    originalName: place.originalName,
    fileKind: hit.fileKind,
    size: hit.size,
    locationId: place.id,
    kept: true,
    fileSays: hit.label?.outcome ?? null,
    ...extra,
  };
}

const empty = {
  failure: {
    suspectedCause: null,
    suspectedBy: null,
    confirmedCause: null,
    confirmedBy: null,
    confirmMethod: null,
    confirmNote: null,
    confirmRun: null,
    confirmSha256: null,
    confirmedAt: null,
    confirmRecordedBy: null,
    confirmerAttestedAt: null,
    taxonomyVersion: null,
    technique: null,
    failedStep: null,
    causeCategory: null,
  },
  debrief: { aim: null, expectedSeen: null, howFound: null, whatChanged: null, fixWorked: null, whoElse: null, debriefedAt: null },
  plan: { planned: null, asRun: null },
  share: false,
} satisfies Partial<RunRecord>;

const refOf = (run: Pick<RunRecord, "id" | "title" | "startedOn" | "status">): RunRef => ({ id: run.id, title: run.title, startedOn: run.startedOn, status: run.status });

const firstTry: RunRecord = {
  ...empty,
  id: FIRST_TRY,
  title: "BM3 expression, first try",
  startedOn: "2026-10-14",
  endedOn: "2026-10-15",
  experiment: bm3 ?? null,
  person: priya ?? null,
  status: "failed",
  statusBy: priyaUser,
  statusAt: "2026-10-15T17:02:00Z",
  createdBy: priyaUser,
  createdAt: "2026-10-15T17:00:00Z",
  updatedAt: "2026-10-15T17:02:00Z",
  retryOf: null,
  retriedIn: [],
  retryHint: null,
  files: [fileOf(searchHits[0]), fileOf(searchHits[3], { role: "shared_control" })],
};

const retry: RunRecord = {
  ...empty,
  id: RETRY,
  title: "BM3 expression, induced at 18 °C",
  startedOn: "2026-11-03",
  endedOn: null,
  experiment: bm3 ?? null,
  person: priya ?? null,
  status: "worked",
  // Read from the first file's label when the run was made.
  statusBy: null,
  statusAt: "2026-11-04T09:30:00Z",
  createdBy: priyaUser,
  createdAt: "2026-11-04T09:30:00Z",
  updatedAt: "2026-11-04T09:30:00Z",
  retryOf: refOf(firstTry),
  retriedIn: [],
  retryHint: null,
  files: [fileOf(searchHits[1], { fileSays: "worked" }), fileOf(searchHits[2])],
};
firstTry.retriedIn = [refOf(retry)];

const unmarked: RunRecord = {
  ...empty,
  id: UNMARKED,
  title: "Solubility screen, plate 2",
  startedOn: "2026-11-09",
  endedOn: null,
  experiment: solubility ?? null,
  person: jordan ?? null,
  status: null,
  statusBy: null,
  statusAt: null,
  createdBy: priyaUser,
  createdAt: "2026-11-10T11:15:00Z",
  updatedAt: "2026-11-10T11:15:00Z",
  retryOf: null,
  retriedIn: [],
  retryHint: null,
  files: [fileOf(searchHits[4], { fileSays: "unclear" }), fileOf(searchHits[5], { locationId: null }), fileOf(recentFiles[0], { kept: false })],
};

export const fixtureRuns: readonly RunRecord[] = [unmarked, retry, firstTry];

export const fixtureSuggestions: RunSuggestion[] = [recentFiles[1], searchHits[2]].flatMap((hit, i) =>
  hit === undefined
    ? []
    : [RunSuggestion.parse({ key: `file:${hit.sha256}`, shas: [hit.sha256], title: hit.label?.cleanName ?? hit.locations[0].originalName, date: i === 0 ? "2026-11-06" : "2026-10-30", fileSays: i === 0 ? "failed" : "worked" })],
);

export function rowOf(run: RunRecord): RunRow {
  return {
    id: run.id,
    title: run.title,
    startedOn: run.startedOn,
    status: run.status,
    experiment: run.experiment?.name ?? null,
    person: run.person?.name ?? null,
    files: run.files.length,
    retryOf: run.retryOf,
    confirmed: run.failure.confirmedCause !== null,
    technique: run.failure.technique,
    failedStep: run.failure.failedStep,
    causeCategory: run.failure.causeCategory,
  };
}

// What a slice's fixture methods read and write: the page's own copy of the runs.
export type FixtureRunStore = {
  get: (id: RunId) => RunRecord;
  put: (run: RunRecord) => RunRecord;
  all: () => RunRecord[];
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const everyFile = new Map<Sha256, FileHit>([...searchHits, ...recentFiles].map((h) => [h.sha256, h]));

// An in-memory run record: writes land in this page's copy and nowhere else.
export function createFixtureRuns(): RunsApi {
  const runs = new Map<RunId, RunRecord>(fixtureRuns.map((r) => [r.id, structuredClone(r)]));
  let suggestions = [...fixtureSuggestions];
  let made = 0;
  const store: FixtureRunStore = {
    get: (runId) => {
      const run = runs.get(runId);
      if (run === undefined) throw new Error("That run doesn't exist any more.");
      return run;
    },
    put: (run) => {
      const next = { ...run, updatedAt: new Date().toISOString() };
      runs.set(next.id, next);
      return next;
    },
    all: () => [...runs.values()],
  };
  const filesOf = (shas: readonly Sha256[], role: RunFile["role"]) => shas.map((sha) => fileOf(everyFile.get(sha), { role }));

  const core: RunsCoreApi = {
    run: async (runId) => {
      await wait(60);
      return store.get(runId);
    },
    list: async ({ filter, offset }) => {
      await wait(60);
      return store
        .all()
        .filter((r) => filter.status === undefined || (filter.status === "none" ? r.status === null : r.status === filter.status))
        .map(rowOf)
        .slice(offset);
    },
    fileRuns: async (shas) => {
      await wait(60);
      return shas.flatMap((sha) => {
        const run = store.all().find((r) => r.files.some((f) => f.sha256 === sha && f.role === "evidence"));
        return run === undefined ? [] : [{ sha256: sha, runId: run.id, title: run.title, status: run.status }];
      });
    },
    suggestions: async () => suggestions,
    dismissSuggestions: async () => {
      suggestions = [];
    },
    retryCandidates: async (runId, query) => {
      await wait(60);
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      return store
        .all()
        .filter((r) => r.id !== runId && r.retryOf?.id !== runId && words.every((w) => r.title.toLowerCase().includes(w)))
        .map(refOf);
    },
    create: async (shas, fields) => {
      await wait(150);
      const files = filesOf(shas, "evidence");
      const first = files[0];
      if (first === undefined) throw new Error("Pick at least one file.");
      made += 1;
      const now = new Date().toISOString();
      const says = first.fileSays === "worked" || first.fileSays === "failed" ? first.fileSays : null;
      const status = fields.status === undefined ? says : fields.status;
      suggestions = suggestions.filter((s) => !s.shas.some((sha) => shas.includes(sha)));
      return store.put({
        ...empty,
        id: id(100 + made),
        title: fields.title ?? first.name,
        startedOn: fields.startedOn ?? everyFile.get(first.sha256)?.label?.date ?? null,
        endedOn: fields.endedOn ?? null,
        experiment: everyFile.get(first.sha256)?.label?.experiment ?? null,
        person: everyFile.get(first.sha256)?.label?.person ?? null,
        status,
        statusBy: fields.status === undefined || status === null ? null : priyaUser,
        statusAt: status === null ? null : now,
        createdBy: priyaUser,
        createdAt: now,
        updatedAt: now,
        retryOf: null,
        retriedIn: [],
        retryHint: null,
        files,
      });
    },
    edit: async (runId, fields) => {
      await wait(120);
      const run = store.get(runId);
      return store.put({ ...run, title: fields.title ?? run.title, startedOn: fields.startedOn === undefined ? run.startedOn : fields.startedOn });
    },
    setStatus: async (runId, status, clearCauses) => {
      await wait(120);
      const run = store.get(runId);
      const keeps = status === "failed" || status === "odd";
      const hasCause = run.failure.suspectedCause !== null || run.failure.confirmedCause !== null;
      if (!keeps && hasCause && !clearCauses) return { kind: "has_causes" };
      return {
        kind: "saved",
        run: store.put({ ...run, status, statusBy: status === null ? null : priyaUser, statusAt: status === null ? null : new Date().toISOString(), failure: keeps ? run.failure : empty.failure }),
      };
    },
    addFiles: async (runId, shas, role) => {
      await wait(120);
      const run = store.get(runId);
      const added = filesOf(shas.filter((sha) => !run.files.some((f) => f.sha256 === sha)), role);
      return store.put({ ...run, files: [...run.files.map((f) => (shas.includes(f.sha256) ? { ...f, role } : f)), ...added] });
    },
    removeFile: async (runId, sha) => {
      await wait(120);
      const run = store.get(runId);
      if (run.files.length === 1) throw new Error("A run keeps at least one file. Add another before taking this one out.");
      return store.put({ ...run, files: run.files.filter((f) => f.sha256 !== sha) });
    },
    linkRetry: async (runId, retryOf) => {
      await wait(120);
      const run = store.get(runId);
      for (const other of store.all()) runs.set(other.id, { ...other, retriedIn: other.retriedIn.filter((r) => r.id !== runId) });
      if (retryOf !== null) {
        const earlier = store.get(retryOf);
        runs.set(earlier.id, { ...earlier, retriedIn: [...earlier.retriedIn, refOf(run)] });
      }
      return store.put({ ...store.get(runId), retryOf: retryOf === null ? null : refOf(store.get(retryOf)), retryHint: null });
    },
  };
  return { ...core, ...fixtureFailureApi(store), ...fixtureEvidenceApi(store), ...fixtureSharingApi(store), ...fixtureDebriefApi(store) };
}
