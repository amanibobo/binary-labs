"use client";

import { useState, type ReactNode } from "react";
import { LabApiProvider, type LabApi } from "@/components/lab-api";
import { OnboardingSaveProvider } from "@/components/onboarding/onboarding-context";
import type { FileHit } from "@/lib/domain";
import { matchesFilters } from "@/lib/filters";
import type { SourceState } from "@/lib/source-state";
import type { TalkThrough } from "@/lib/talk-throughs";
import type { ProtocolVideo } from "@/lib/videos";
import { folderFixtureFiles, folders, laterLabels, needsLookFiles, recentFiles, searchHits } from "./data";
import { createFixtureLabels } from "./fixture-labels";
import { NOTE_PAGE_PREVIEWS, smartFiles, voiceNote } from "./smart-labels";
import { PREVIEW_BY_FIRST_CHAR } from "./previews";
import { protocolHits, purification, purificationTheirs } from "./protocols";
import { fixtureUploadTalkThrough, fixtureApplyTalkThrough, talkThrough as fixtureTalkThrough } from "./talk-throughs";
import { createFixtureUploads } from "./uploads";
import { createFixtureVideoUploads, FIXTURE_VIDEO, fixtureVideoSources, pageVideos } from "./videos";
import { chartsOf, fixtureTable, savedCharts, savedLayouts } from "./charts";
import { LayoutId } from "@/lib/ids";
import { SaveLayoutRequest, type SavedLayout } from "@/lib/layouts";
import { fixtureHubFiles, fixtureLab, fixtureLocal, type LabSize } from "./map";
import { ChartId, UserId } from "@/lib/ids";
import { CreateChartRequest, SaveChartRequest } from "@/lib/charts";
import { ReviewRequest } from "@/lib/flags";
import { bradfordAssay, fixtureFileChecks, fixtureFlagMarks, flagTable } from "./flags";

// The provider has already applied the event on screen; there's no server to tell.
const keepOnboardingInMemory = async () => undefined;

export type FixtureSearchMode = "hybrid" | "keyword";

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(signal.reason);
    });
  });

// Every query gets the same results, except that recent files holding the query come first
// ("plate 7" finds the plate 7 read; "failed drug A" finds the drug A runs, the failed one
// first), so the cold reads can search for something. A word from page 7 of the notebook opens
// the note at that page, as search_files does.
function fixtureResults(q: string): FileHit[] {
  const wanted = q.trim().toLowerCase();
  const words = wanted.split(/\s+/).filter((w) => w.length >= 3 && !["the", "and", "run", "for"].includes(w));
  const text = (h: FileHit) =>
    [
      h.locations[0].path,
      h.snippet ?? "",
      h.label?.cleanName ?? "",
      h.label?.summary ?? "",
      h.label?.outcome ?? "",
      ...(h.label?.conditions ?? []).map((c) => `${c.what} ${c.value ?? ""} ${c.unit ?? ""}`),
      ...(h.label?.tags ?? []),
    ]
      .join(" ")
      .toLowerCase();
  // Page 7 of the notebook says "evaporation at the edges? lids fogged".
  const page7 = /evaporat|edge check|lids/.test(wanted);
  const onPage7 = (h: FileHit) => (page7 && h.label?.note != null ? words.length : 0);
  const score = (h: FileHit) =>
    onPage7(h) + (text(h).includes(wanted) ? words.length + 1 : words.filter((w) => text(h).includes(w)).length);
  const found = [...smartFiles, ...recentFiles]
    .filter((h) => !searchHits.some((s) => s.sha256 === h.sha256) && score(h) > 0)
    .toSorted((a, b) => score(b) - score(a))
    .map((h): FileHit => ({ ...h, matchedBy: ["words"], matchedPage: page7 && h.label?.note != null ? 7 : null }));
  return [...found, ...searchHits];
}

function keywordOnly(hits: FileHit[]): FileHit[] {
  return hits.filter((h) => h.matchedBy.includes("words")).map((h) => ({ ...h, matchedBy: ["words"] }));
}

// "stale" makes every save find that someone else saved first, for the conflict screenshots.
export type FixtureSaves = "saved" | "stale";

// "waiting" holds every file's table on its way, for the screenshot of the builder reading it.
export type FixtureTables = "ready" | "waiting";

export function FixtureLabApi({
  mode,
  source,
  saves = "saved",
  earlierUploads = true,
  talkThrough,
  videos = pageVideos,
  tables = "ready",
  mapSize = null,
  children,
}: {
  mode: FixtureSearchMode;
  source: SourceState;
  saves?: FixtureSaves;
  earlierUploads?: boolean;
  // What polling a talk-through answers; it stays put, so a screenshot holds one state.
  talkThrough?: TalkThrough;
  // What polling a page's videos answers; it stays put, like talkThrough.
  videos?: ProtocolVideo[];
  tables?: FixtureTables;
  // The generated lab the map's fixtures draw.
  mapSize?: LabSize | null;
  children: ReactNode;
}) {
  const [uploads] = useState(() => createFixtureUploads({ earlier: earlierUploads }));
  const [videoUploads] = useState(createFixtureVideoUploads);
  const [layoutStore] = useState(() => [...savedLayouts]);
  const [map] = useState(() => (mapSize === null ? null : fixtureLab(mapSize)));
  const [labels] = useState(() =>
    createFixtureLabels({ initial: [...searchHits, ...recentFiles, ...needsLookFiles, ...smartFiles, voiceNote], later: laterLabels }),
  );
  const withLabels = (hits: FileHit[]) => hits.map((h) => ({ ...h, label: labels.get(h.sha256) }));
  const api: LabApi = {
    search: async (params, signal) => {
      await wait(120, signal);
      const hits = withLabels(fixtureResults(params.q)).filter((h) => matchesFilters(h, params));
      return mode === "hybrid"
        ? { kind: "hybrid", results: hits, protocols: protocolHits }
        : { kind: "keyword", reason: "embed_timeout", results: keywordOnly(hits), protocols: protocolHits };
    },
    sourceState: async () => source,
    folders: async (path, signal) => {
      await wait(150, signal);
      return { path, folders: folders[path] ?? [] };
    },
    folderFiles: async (path, offset, signal) => {
      await wait(150, signal);
      return folderFixtureFiles(path, offset);
    },
    previewUrl: (sha) => NOTE_PAGE_PREVIEWS.get(sha) ?? PREVIEW_BY_FIRST_CHAR[sha.charAt(0)] ?? "",
    fileLabels: async (shas, signal) => {
      await wait(80, signal);
      return labels.poll(shas);
    },
    correctLabel: async (sha, draft) => {
      await wait(150);
      return labels.correct(sha, draft);
    },
    undoCorrection: async (id) => {
      await wait(150);
      return labels.undo(id);
    },
    changeNote: async () => {
      await wait(150);
    },
    protocol: async (_id, signal) => {
      await wait(150, signal);
      return purificationTheirs;
    },
    createProtocol: async () => {
      await wait(200);
      return { protocolId: purification.protocolId, versionId: purification.id, version: 1 };
    },
    saveProtocol: async (id, req) => {
      await wait(200);
      if (saves === "stale" && req.baseVersionId !== purificationTheirs.id) return { kind: "stale" };
      return { kind: "saved", protocolId: id, versionId: purification.id, version: purification.version + 1 };
    },
    archiveProtocol: async () => wait(150),
    linkProtocolFile: async () => wait(150),
    unlinkProtocolFile: async () => wait(150),
    uploadFile: uploads.uploadFile,
    myUploads: uploads.myUploads,
    uploadTalkThrough: fixtureUploadTalkThrough,
    talkThrough: async (_id, signal) => {
      await wait(80, signal);
      return talkThrough ?? fixtureTalkThrough("ready");
    },
    retryTalkThrough: async () => wait(150),
    applyTalkThrough: fixtureApplyTalkThrough,
    dismissTalkThrough: async () => wait(150),
    mediaUrl: () => FIXTURE_VIDEO,
    draftStepsFromVideo: async () => {
      await wait(150);
      return (talkThrough ?? fixtureTalkThrough("ready")).id;
    },
    ...videoUploads,
    abortVideoUpload: async () => wait(100),
    protocolVideos: async (_id, signal) => {
      await wait(80, signal);
      return videos;
    },
    videoSources: fixtureVideoSources,
    retryVideoTranscript: async () => wait(150),
    removePendingVideo: async () => wait(150),
    dataTable: async (sha, signal) => {
      await wait(120, signal);
      return tables === "waiting" ? { state: "waiting" } : (flagTable(sha) ?? fixtureTable(sha));
    },
    requestDataTable: async () => wait(100),
    fileCharts: async (sha, signal) => {
      await wait(80, signal);
      return chartsOf(sha);
    },
    createChart: async (req) => {
      await wait(200);
      const now = new Date().toISOString();
      const id = ChartId.parse("8c1c2c39-5a4e-4c55-9d7b-0c3c1a7c9999");
      const createdBy = UserId.parse("00000000-0000-4000-8000-00000000000a");
      return { ...CreateChartRequest.parse(req), id, protocolVersionId: null, createdBy, createdAt: now, updatedAt: now };
    },
    layouts: async (signal) => {
      await wait(80, signal);
      return [...layoutStore];
    },
    saveLayout: async (req) => {
      await wait(150);
      const r = SaveLayoutRequest.parse(req);
      const saved: SavedLayout = { id: LayoutId.parse(`9d1c2c39-5a4e-4c55-9d7b-0c3c1a7d${String(layoutStore.length + 10).padStart(4, "0")}`), ...r, updatedAt: new Date().toISOString() };
      layoutStore.unshift(saved);
      return saved;
    },
    updateLayout: async (id, req) => {
      await wait(150);
      const r = SaveLayoutRequest.parse(req);
      const saved: SavedLayout = { id, ...r, updatedAt: new Date().toISOString() };
      const i = layoutStore.findIndex((l) => l.id === id);
      if (i >= 0) layoutStore.splice(i, 1, saved);
      return saved;
    },
    deleteLayout: async (id) => {
      await wait(100);
      const i = layoutStore.findIndex((l) => l.id === id);
      if (i >= 0) layoutStore.splice(i, 1);
    },
    saveChart: async (id, req) => {
      await wait(200);
      const chart = savedCharts.find((c) => c.id === id) ?? savedCharts[0];
      if (saves === "stale") return { kind: "stale" };
      const { sheet, title, spec, protocolId } = SaveChartRequest.parse(req);
      return { kind: "saved", chart: { ...chart, sheet, title, spec, protocolId, updatedAt: new Date().toISOString() } };
    },
    deleteChart: async () => wait(150),
    mapHub: async (q, signal) => {
      await wait(150, signal);
      if (map === null) throw new Error("no fixture map");
      return fixtureHubFiles(map, q);
    },
    mapLocal: async (q, signal) => {
      await wait(150, signal);
      const view = map === null ? null : fixtureLocal(map, q);
      if (view === null) throw new Error("no such node in the fixture map");
      return view;
    },
    fileChecks: async (sha, signal) => {
      await wait(80, signal);
      return fixtureFileChecks(sha);
    },
    flagMarks: async (shas, signal) => {
      await wait(60, signal);
      return fixtureFlagMarks(shas);
    },
    reviewFlag: async (_id, req) => {
      await wait(150);
      const { review, note } = ReviewRequest.parse(req);
      return { review, note, by: UserId.parse("00000000-0000-4000-8000-00000000000a"), at: new Date().toISOString() };
    },
    saveChecks: async (id) => {
      await wait(200);
      return saves === "stale" ? { kind: "stale" } : { kind: "saved", protocolId: id, versionId: bradfordAssay.id, version: bradfordAssay.version + 1 };
    },
  };
  return (
    <LabApiProvider value={api}>
      <OnboardingSaveProvider value={keepOnboardingInMemory}>{children}</OnboardingSaveProvider>
    </LabApiProvider>
  );
}
