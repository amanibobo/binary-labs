import type { EvidenceApi } from "@/components/runs/api/evidence";
import type { PlanChoice } from "@/lib/as-run";
import { ExperimentId, ProtocolId, ProtocolVersionId, UserId, type RunId } from "@/lib/ids";
import type { RunRecord } from "@/lib/run-record";
import type { EditedFile } from "@/lib/run-originals";
import { experiments, members, searchHits } from "./data";
import { history, protocolList, purification, purificationBody, purificationV2 } from "./protocols";
import { FIRST_TRY, type FixtureRunStore } from "./runs";

// Slice B's fixture twin: planned versus actual over the page's own copy of the runs. The BM3
// runs follow the purification protocol's four versions; the first try's gel was edited in
// the lab's folder after the run.

type Version = Omit<PlanChoice, "current" | "suggested" | "picked"> & { body: string };

const purificationVersions: Version[] = history.map((h) => ({
  versionId: h.id,
  protocolId: purification.protocolId,
  title: h.title,
  version: h.version,
  savedAt: h.createdAt,
  body:
    h.version === 4
      ? purificationBody
      : h.version === 3
        ? purificationBody.replace("15,000 g for 30 min", "15,000 g for 20 min")
        : h.version === 2
          ? purificationV2.body
          : purificationV2.body.replace("Run this for every BM3 batch.", "Run this for each batch."),
}));

const otherVersions: Version[] = protocolList
  .filter((p) => p.kind === "protocol" && p.id !== purification.protocolId)
  .map((p, i) => ({
    versionId: ProtocolVersionId.parse(`7a1c2c39-5a4e-4c55-9d7b-0c3c1a7c${String(i + 1).padStart(4, "0")}`),
    protocolId: ProtocolId.parse(p.id),
    title: p.title,
    version: p.version,
    savedAt: p.updatedAt,
    body: `## Steps\n\n1. Read the ${p.title.toLowerCase()} sheet by the bench.\n2. Follow it step by step.\n`,
  }));

const versions = [...purificationVersions, ...otherVersions];
// The P450 BM3 experiment's protocol page is the purification protocol.
const PROTOCOL_OF = new Map([[ExperimentId.parse(experiments[0]?.id), purification.protocolId]]);
const priyaUser = UserId.parse(members[1]?.userId);

const versionOf = (id: ProtocolVersionId | null | undefined) => versions.find((v) => v.versionId === id) ?? null;

function suggestedFor(run: RunRecord): Version | null {
  const protocolId = run.experiment === null ? undefined : PROTOCOL_OF.get(run.experiment.id);
  const own = purificationVersions.filter((v) => v.protocolId === protocolId).sort((a, b) => b.version - a.version);
  const day = run.startedOn ?? new Date().toISOString().slice(0, 10);
  return own.find((v) => v.savedAt.slice(0, 10) <= day) ?? own.at(-1) ?? null;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const fixtureEvidenceApi = (store: FixtureRunStore): EvidenceApi => ({
  editedFiles: async (id: RunId) => {
    await wait(60);
    const gel = store.get(id).files.find((f) => f.sha256 === searchHits[0]?.sha256);
    if (id !== FIRST_TRY || gel === undefined || gel.locationId === null) return [];
    const edited: EditedFile = { sha256: gel.sha256, locationId: gel.locationId, heldVersion: 1, heldAt: "2026-10-15T16:40:00Z", latestVersion: 2, latestAt: "2026-10-22T10:05:00Z" };
    return [edited];
  },
  planBodies: async (id) => {
    await wait(60);
    const run = store.get(id);
    const based = versionOf(run.plan.asRun?.basedOn);
    return {
      planned: versionOf(run.plan.planned?.versionId)?.body ?? null,
      basedOn: based === null ? null : { versionId: based.versionId, title: based.title, version: based.version, body: based.body },
    };
  },
  planChoices: async (id, query) => {
    await wait(60);
    const run = store.get(id);
    const suggested = suggestedFor(run);
    const picked = run.plan.planned?.versionId ?? null;
    const protocolId = run.experiment === null ? undefined : PROTOCOL_OF.get(run.experiment.id);
    const tier = (v: Version) => (v.versionId === suggested?.versionId ? 0 : v.versionId === picked ? 1 : v.protocolId === protocolId ? 2 : 3);
    const newest = new Map<ProtocolId, number>();
    for (const v of versions) newest.set(v.protocolId, Math.max(newest.get(v.protocolId) ?? 0, v.version));
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return versions
      .filter((v) => tier(v) < 3 || v.version === newest.get(v.protocolId))
      .filter((v) => words.every((w) => v.title.toLowerCase().includes(w)))
      .sort((a, b) => tier(a) - tier(b) || (tier(a) === 2 ? b.version - a.version : a.title.localeCompare(b.title)))
      .map((v): PlanChoice => ({
        versionId: v.versionId,
        protocolId: v.protocolId,
        title: v.title,
        version: v.version,
        savedAt: v.savedAt,
        current: v.version === newest.get(v.protocolId),
        suggested: tier(v) === 0,
        picked: v.versionId === picked,
      }))
      .slice(0, 12);
  },
  setPlan: async (id, versionId) => {
    await wait(120);
    const run = store.get(id);
    const v = versionOf(versionId);
    return store.put({ ...run, plan: { ...run.plan, planned: v === null ? null : { versionId: v.versionId, protocolId: v.protocolId, title: v.title, version: v.version } } });
  },
  saveAsRun: async (id, { body, basedOn }) => {
    await wait(150);
    const run = store.get(id);
    const asRun = body.trim() === "" ? null : { body, basedOn, by: priyaUser, at: new Date().toISOString() };
    return store.put({ ...run, plan: { ...run.plan, asRun } });
  },
});
