import type { SendResult } from "@/lib/upload-queue";
import {
  ProtocolVideosRows,
  VideoUploadId,
  type ProtocolVideo,
  type ReadyVideo,
  type StartVideoRequest,
  type UploadedPart,
  type VideoReceipt,
  type VideoSession,
} from "@/lib/videos";
import { LocationId, Sha256 } from "@/lib/ids";

// Dev-only screenshot data for procedure videos, parsed through the row schema. Imported only
// from *.dev.tsx pages and the fixture API.

export const VIDEO_TRANSCRIPT = `So this is how we load the BM3 lysate onto the nickel column. Equilibrate the column first with five column volumes of lysis buffer at one mL a minute. Then load the cleared lysate slowly, still one mL a minute, and don't let the column run dry. Keep the flow-through on ice, we run it on the gel tomorrow. Then wash with ten column volumes of wash buffer, and you should see the brown band stay at the top of the column.`;

const loc = (n: number) => `9c1c2c39-5a4e-4c55-9d7b-0c3c1a7a${String(n).padStart(4, "0")}`;

export const pageVideos: ProtocolVideo[] = ProtocolVideosRows.parse([
  {
    state: "ready",
    location_id: loc(1),
    sha256: "c1".repeat(32),
    name: "Loading the nickel column.mp4",
    path: "/Uploads/Videos/Loading the nickel column.mp4",
    source_kind: "upload",
    mime: "video/mp4",
    size: 184_000_000,
    has_poster: true,
    transcript: "ready",
    transcript_error: null,
    transcript_text: VIDEO_TRANSCRIPT,
  },
  {
    state: "ready",
    location_id: loc(2),
    sha256: "c2".repeat(32),
    name: "Sonication setup 2025.mov",
    path: "/Lab/Training/Sonication setup 2025.mov",
    source_kind: "dropbox",
    mime: "video/quicktime",
    size: 96_000_000,
    has_poster: true,
    transcript: "waiting",
    transcript_error: null,
    transcript_text: null,
  },
  { state: "preparing", location_id: loc(3), name: "Video 2026-11-04 14.12.08.mov", size: 212_000_000 },
]);

export const FIXTURE_VIDEO = "/dev/fixtures/media/bench.webm";
export const FIXTURE_POSTER = "/dev/fixtures/media/bench-poster.webp";

export function fixtureVideoSources(video: ReadyVideo): { src: string; poster: string | null } {
  return { src: FIXTURE_VIDEO, poster: video.hasPoster ? FIXTURE_POSTER : null };
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new Error("stopped"));
    });
  });

// A file named "…column…" holds its second part at half way, for the progress screenshot; one
// named "…Sonication…" loses its first part once, for the retry screenshot.
export function createFixtureVideoUploads() {
  let dropped = false;
  let next = 1;
  const names = new Map<string, string>();
  return {
    startVideoUpload: async (req: StartVideoRequest): Promise<SendResult<VideoSession>> => {
      await wait(150);
      const uploadId = VideoUploadId.parse(`9d1c2c39-5a4e-4c55-9d7b-0c3c1a7a${String(next++).padStart(4, "0")}`);
      names.set(uploadId, req.name);
      return { kind: "stored", receipt: { uploadId, storeId: uploadId } };
    },
    sendVideoPart: async (
      session: VideoSession,
      part: { partNumber: number; bytes: Blob; fileSize: number },
      onProgress: (sent: number) => void,
      signal: AbortSignal,
    ): Promise<SendResult<UploadedPart>> => {
      const name = names.get(session.uploadId) ?? "";
      try {
        if (name.includes("Sonication") && !dropped) {
          dropped = true;
          onProgress(part.bytes.size * 0.4);
          await wait(300, signal);
          return { kind: "interrupted", message: "The connection dropped." };
        }
        if (name.includes("column") && part.partNumber === 2) {
          onProgress(part.bytes.size * 0.5);
          await wait(60 * 60 * 1000, signal);
        }
        for (const share of [0.3, 0.7, 1]) {
          await wait(120, signal);
          onProgress(part.bytes.size * share);
        }
      } catch {
        return { kind: "interrupted", message: "The upload was stopped." };
      }
      return { kind: "stored", receipt: { partNumber: part.partNumber, etag: `"part-${part.partNumber}"` } };
    },
    completeVideoUpload: async (): Promise<SendResult<VideoReceipt>> => {
      await wait(400);
      return {
        kind: "stored",
        receipt: { locationId: LocationId.parse(loc(50)), sha256: Sha256.parse("c5".repeat(32)), duplicate: false, linked: false },
      };
    },
  };
}
