// Written by scripts/record-clips.mjs; rerun it rather than editing by hand.
import type { ClipId } from "@/lib/onboarding";

export const CLIP_SIZES = {
  search: { width: 720, height: 450 },
  open: { width: 720, height: 450 },
  fix: { width: 720, height: 450 },
  "needs-look": { width: 720, height: 450 },
  upload: { width: 390, height: 600 },
  "talk-through": { width: 720, height: 450 },
  video: { width: 720, height: 450 },
  settings: { width: 720, height: 450 },
} as const satisfies Record<ClipId, { width: number; height: number }>;
