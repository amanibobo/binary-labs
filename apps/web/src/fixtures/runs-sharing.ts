import { SHARING_AGREEMENT, type LabSharing, type RunSharing, type ShareBlock, type SharingApi, type SharingLogEntry } from "@/components/runs/api/sharing";
import { UserId, type RunId } from "@/lib/ids";
import { members } from "./data";
import { RETRY, UNMARKED, type FixtureRunStore } from "./runs";

// Slice C's fixture twin. The viewer is Priya, a member who ran the first two runs. The lab
// has agreed; the retry is shared and has one task folder built from it (so turning it off
// asks first); the unmarked run is Jordan's, shared, with a confirmed cause Jordan hasn't
// attested. ?lab=off on a run's fixture page shows the lab before anyone agreed.

const adeUser = UserId.parse(members[0]?.userId);
const priyaUser = UserId.parse(members[1]?.userId);
const jordanUser = UserId.parse(members[2]?.userId);

const agreed: LabSharing = { agreedAt: "2026-11-05T10:12:00Z", agreement: SHARING_AGREEMENT.version, agreedBy: "Ade Okafor", canChange: true, demo: false, built: 1 };
const notAgreed: LabSharing = { agreedAt: null, agreement: null, agreedBy: null, canChange: true, demo: false, built: 0 };

export type LabSharingFixture = "off" | "on" | "demo";
export function fixtureLabSharing(state: LabSharingFixture, isAdmin: boolean): LabSharing {
  const lab = state === "on" ? agreed : state === "demo" ? { ...notAgreed, demo: true } : notAgreed;
  return { ...lab, canChange: isAdmin };
}

let nextId = 100;
const entry = (fields: Pick<SharingLogEntry, "action" | "after" | "at"> & Partial<SharingLogEntry>): SharingLogEntry => {
  nextId += 1;
  return { id: nextId, runId: null, runTitle: null, via: "person", actor: priyaUser, actorName: "Priya Nair", before: null, ...fields };
};

// Built when asked, not when this file loads: ./runs and this file import each other.
function seedLogs() {
  const retryTitle = "BM3 expression, induced at 18 °C";
  const ade = { actor: adeUser, actorName: "Ade Okafor" };
  const retry = [
    entry({ runId: RETRY, runTitle: retryTitle, action: "export.allowed", after: { purpose: "task folder" }, at: "2026-11-12T14:31:00Z", ...ade }),
    entry({ runId: RETRY, runTitle: retryTitle, action: "run.share", after: { share: true }, at: "2026-11-12T14:25:00Z" }),
    entry({ runId: RETRY, runTitle: retryTitle, action: "export.blocked", after: { blocks: ["run_off"] }, at: "2026-11-12T14:20:00Z", ...ade }),
  ];
  const unmarked = [
    entry({ runId: UNMARKED, runTitle: "Solubility screen, plate 2", action: "run.share", after: { share: true }, at: "2026-11-11T09:02:00Z", actor: jordanUser, actorName: "Jordan Morales" }),
  ];
  const lab = [...retry, ...unmarked, entry({ action: "lab.share", after: { agreedAt: agreed.agreedAt, agreement: SHARING_AGREEMENT.version }, at: "2026-11-05T10:12:00Z", ...ade })];
  return { retry, unmarked, lab };
}
export const fixtureSharingLog = (): SharingLogEntry[] => seedLogs().lab;

type RunState = { share: boolean; canChange: boolean; built: number; withdrawn: number; attested: boolean; log: SharingLogEntry[] };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const fixtureSharingApi: (store: FixtureRunStore) => SharingApi = (store) => {
  const labOff = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("lab") === "off";
  const seed = seedLogs();
  let lab = labOff ? notAgreed : agreed;
  let labLog = labOff ? [] : seed.lab;
  const states = new Map<RunId, RunState>([
    [RETRY, { share: true, canChange: true, built: labOff ? 0 : 1, withdrawn: 0, attested: true, log: seed.retry }],
    [UNMARKED, { share: true, canChange: false, built: 0, withdrawn: 0, attested: false, log: seed.unmarked }],
  ]);
  const stateOf = (id: RunId): RunState => {
    const known = states.get(id);
    if (known !== undefined) return known;
    const fresh: RunState = { share: false, canChange: true, built: 0, withdrawn: 0, attested: true, log: [] };
    states.set(id, fresh);
    return fresh;
  };
  const sharingOf = (state: RunState): RunSharing => {
    const blocks: ShareBlock[] = [
      ...(state.share ? [] : (["run_off"] as const)),
      ...(lab.agreedAt === null ? (["lab_off"] as const) : []),
      ...(state.attested ? [] : (["not_attested"] as const)),
    ];
    return { share: state.share, canChange: state.canChange, blocks, built: state.built, withdrawn: state.withdrawn };
  };

  return {
    labSharing: async () => lab,
    setLabShare: async (on, agreement) => {
      await wait(150);
      const at = new Date().toISOString();
      lab = on ? { ...lab, agreedAt: at, agreement, agreedBy: "Ade Okafor" } : { ...lab, agreedAt: null, agreement: null, agreedBy: null, built: 0 };
      labLog = [entry({ action: "lab.share", after: { agreedAt: lab.agreedAt, agreement: lab.agreement }, at, actor: adeUser, actorName: "Ade Okafor" }), ...labLog];
      return lab;
    },
    runSharing: async (id) => {
      await wait(60);
      return sharingOf(stateOf(id));
    },
    setRunShare: async (id, on) => {
      await wait(150);
      const state = stateOf(id);
      if (!state.canChange) throw new Error("Only the person who ran this run, or an admin, can change its sharing.");
      const run = store.get(id);
      const at = new Date().toISOString();
      const rows = [entry({ runId: id, runTitle: run.title, action: "run.share", after: { share: on }, at })];
      if (!on && state.built > 0) rows.unshift(entry({ runId: id, runTitle: run.title, action: "export.blocked", after: { blocks: ["withdrawn"], folders: state.built }, at }));
      states.set(id, { ...state, share: on, built: on ? state.built : 0, withdrawn: on ? state.withdrawn : state.withdrawn + state.built, log: [...rows, ...state.log] });
      return store.put({ ...run, share: on });
    },
    sharingLog: async (runId) => {
      await wait(60);
      return runId === null ? labLog : stateOf(runId).log;
    },
  };
};
