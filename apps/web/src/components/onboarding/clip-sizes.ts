// Written by scripts/record-clips.mjs; rerun it rather than editing by hand.
import type { ClipId } from "@/lib/onboarding";

export const CLIP_SIZES = {
  "search": { width: 720, height: 436 },
  "open": { width: 720, height: 436 },
  "fix": { width: 720, height: 436 },
  "needs-look": { width: 720, height: 402 },
  "upload": { width: 390, height: 460 },
  "talk-through": { width: 720, height: 468 },
  "video": { width: 720, height: 664 },
  "chart": { width: 720, height: 418 },
  "settings": { width: 720, height: 450 },
  "ask": { width: 720, height: 418 },
  "browse": { width: 720, height: 416 },
  "protocols": { width: 720, height: 436 },
  "map": { width: 720, height: 554 },
  "calendar": { width: 720, height: 500 },
  "flags": { width: 720, height: 436 },
  "help": { width: 640, height: 720 },
  "calendar-views": { width: 720, height: 444 },
  "invite": { width: 672, height: 498 },
  "chart-wells": { width: 720, height: 386 },
  "chart-curve": { width: 720, height: 740 },
  "chart-ic50": { width: 720, height: 740 },
} as const satisfies Record<ClipId, { width: number; height: number }>;
