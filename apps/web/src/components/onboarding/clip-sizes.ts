// Written by scripts/record-clips.mjs; rerun it rather than editing by hand.
import type { ClipId } from "@/lib/onboarding";

export const CLIP_SIZES = {
  "search": { width: 720, height: 436 },
  "open": { width: 720, height: 436 },
  "fix": { width: 720, height: 334 },
  "needs-look": { width: 720, height: 402 },
  "upload": { width: 390, height: 460 },
  "talk-through": { width: 720, height: 468 },
  "video": { width: 720, height: 664 },
  "chart": { width: 720, height: 396 },
  "settings": { width: 720, height: 486 },
} as const satisfies Record<ClipId, { width: number; height: number }>;
