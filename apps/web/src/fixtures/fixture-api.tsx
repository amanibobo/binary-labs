"use client";

import { useState, type ReactNode } from "react";
import { LabApiProvider, type LabApi } from "@/components/lab-api";
import type { FileHit } from "@/lib/domain";
import type { SourceState } from "@/lib/source-state";
import type { TalkThrough } from "@/lib/talk-throughs";
import type { ProtocolVideo } from "@/lib/videos";
import { folderFixtureFiles, folders, laterLabels, needsLookFiles, recentFiles, searchHits } from "./data";
import { createFixtureLabels } from "./fixture-labels";
import { PREVIEW_BY_FIRST_CHAR } from "./previews";
import { protocolHits, purification, purificationTheirs } from "./protocols";
import { fixtureUploadTalkThrough, fixtureApplyTalkThrough, talkThrough as fixtureTalkThrough } from "./talk-throughs";
import { createFixtureUploads } from "./uploads";
import { createFixtureVideoUploads, fixtureVideoSources, pageVideos } from "./videos";

export type FixtureSearchMode = "hybrid" | "keyword";

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(signal.reason);
    });
  });

function keywordOnly(hits: FileHit[]): FileHit[] {
  return hits.filter((h) => h.matchedBy.includes("words")).map((h) => ({ ...h, matchedBy: ["words"] }));
}

// "stale" makes every save find that someone else saved first, for the conflict screenshots.
export type FixtureSaves = "saved" | "stale";

export function FixtureLabApi({
  mode,
  source,
  saves = "saved",
  earlierUploads = true,
  talkThrough,
  videos = pageVideos,
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
  children: ReactNode;
}) {
  const [uploads] = useState(() => createFixtureUploads({ earlier: earlierUploads }));
  const [videoUploads] = useState(createFixtureVideoUploads);
  const [labels] = useState(() =>
    createFixtureLabels({ initial: [...searchHits, ...recentFiles, ...needsLookFiles], later: laterLabels }),
  );
  const withLabels = (hits: FileHit[]) => hits.map((h) => ({ ...h, label: labels.get(h.sha256) }));
  const api: LabApi = {
    search: async (_params, signal) => {
      await wait(120, signal);
      return mode === "hybrid"
        ? { kind: "hybrid", results: withLabels(searchHits), protocols: protocolHits }
        : { kind: "keyword", reason: "embed_timeout", results: withLabels(keywordOnly(searchHits)), protocols: protocolHits };
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
    previewUrl: (sha) => PREVIEW_BY_FIRST_CHAR[sha.charAt(0)] ?? "",
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
    ...videoUploads,
    abortVideoUpload: async () => wait(100),
    protocolVideos: async (_id, signal) => {
      await wait(80, signal);
      return videos;
    },
    videoSources: fixtureVideoSources,
    retryVideoTranscript: async () => wait(150),
    removePendingVideo: async () => wait(150),
  };
  return <LabApiProvider value={api}>{children}</LabApiProvider>;
}
