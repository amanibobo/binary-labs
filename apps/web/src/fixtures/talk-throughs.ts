import { TalkThroughId } from "@/lib/ids";
import type { SaveOutcome } from "@/lib/protocols";
import {
  OpenTalkThroughRows,
  TalkThroughReceipt,
  TalkThroughWire,
  type TalkThrough,
  type TalkThroughMeta,
  type TalkThroughStatus,
} from "@/lib/talk-throughs";
import type { SendResult } from "@/lib/upload-queue";
import { purification } from "./protocols";

// Dev-only screenshot data for talk-throughs, parsed through the wire schemas. Imported only
// from *.dev.tsx pages and the fixture API.

const priya = "00000000-0000-4000-8000-00000000000b";
const ttId = (n: number) => TalkThroughId.parse(`5b1c2c39-5a4e-4c55-9d7b-0c3c1a7a${String(n).padStart(4, "0")}`);

export const TRANSCRIPT = `Okay, so this is how I do the lysis for the BM3 batches. First thaw one fifty mL pellet on ice, that takes about twenty minutes. While it thaws, make up the lysis buffer fresh, two hundred mL, and keep it at four degrees. Resuspend the pellet in forty mL of lysis buffer, and pipette, don't vortex, you want it smooth with no clumps. Then sonicate on ice, ten seconds on, twenty seconds off, for five minutes total at forty percent. If it starts to warm up, stop and let it sit on ice for a minute. Then spin at thirty thousand g for forty five minutes at four degrees, and keep the supernatant. That goes straight onto the nickel column.`;

export const DRAFT_TITLE = "BM3 lysis";
export const DRAFT_BODY = `## Materials

- One 50 mL pellet
- 200 mL lysis buffer, made fresh

## Steps

1. Thaw one 50 mL pellet on ice for about 20 minutes.
2. While it thaws, make 200 mL lysis buffer fresh and keep it at 4 degrees.
3. Resuspend the pellet in 40 mL lysis buffer by pipetting until smooth, with no clumps.
4. Sonicate on ice, 10 seconds on and 20 seconds off, for 5 minutes total at 40 percent.
5. Spin at 30,000 g for 45 minutes at 4 degrees and keep the supernatant.
6. Load the supernatant straight onto the nickel column.

## Cautions

- Don't vortex the pellet.
- If the sample warms up while sonicating, stop and let it sit on ice for a minute.
`;

export const STATUSES = {
  transcribing: { kind: "transcribing" },
  drafting: { kind: "drafting", transcript: TRANSCRIPT },
  ready: { kind: "ready", transcript: TRANSCRIPT, title: DRAFT_TITLE, body: DRAFT_BODY },
  "no-draft": {
    kind: "no_draft",
    transcript: TRANSCRIPT,
    message: "Drafting steps needs a model, and none is set up. Start from the transcript instead.",
  },
  failed: {
    kind: "failed",
    stage: "transcribe",
    transcript: null,
    message: "ElevenLabs answered 503: the service is busy. Try again in a minute.",
  },
} satisfies Record<string, TalkThroughStatus>;

export type FixtureStatus = keyof typeof STATUSES;

export function talkThrough(status: FixtureStatus, { forPage = true }: { forPage?: boolean } = {}): TalkThrough {
  return TalkThroughWire.parse({
    id: ttId(1),
    kind: "protocol",
    page: forPage
      ? { protocolId: purification.protocolId, title: purification.title, baseVersionId: purification.id, baseVersion: purification.version }
      : null,
    recordedBy: priya,
    recordedAt: "2026-11-04T14:03:22Z",
    durationMs: 3 * 60_000 + 12_000,
    audio: { locationId: "7a1c2c39-5a4e-4c55-9d7b-000000000090", name: "Talk-through 2026-11-04 14.03.22.weba" },
    status: STATUSES[status],
    used: null,
  });
}

export const openForPage = OpenTalkThroughRows.parse([
  {
    id: ttId(1),
    kind: "protocol",
    recorded_by: priya,
    recorded_at: "2026-11-04T14:03:22Z",
    duration_ms: 192_000,
    index_state: "indexed",
    draft: "ready",
    draft_title: DRAFT_TITLE,
  },
]);

export const openNewPage = OpenTalkThroughRows.parse([
  {
    id: ttId(2),
    kind: "tutorial",
    recorded_by: priya,
    recorded_at: "2026-11-04T16:40:00Z",
    duration_ms: 241_000,
    index_state: "pending",
    draft: "waiting",
    draft_title: null,
  },
]);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The upload route in memory: the recording goes up in a few slices, then the page moves on.
export async function fixtureUploadTalkThrough(
  file: Blob,
  _meta: TalkThroughMeta,
  onProgress: (sent: number) => void,
): Promise<SendResult<TalkThroughReceipt>> {
  for (const share of [0.2, 0.45, 0.7, 1]) {
    await wait(300);
    onProgress(Math.round(file.size * share));
  }
  const receipt = TalkThroughReceipt.parse({
    talkThroughId: ttId(1),
    locationId: talkThrough("ready").audio.locationId,
    sha256: "c".repeat(64),
    duplicate: false,
  });
  return { kind: "stored", receipt };
}

export async function fixtureApplyTalkThrough(): Promise<SaveOutcome> {
  await wait(200);
  return { kind: "saved", protocolId: purification.protocolId, versionId: purification.id, version: purification.version + 1 };
}
