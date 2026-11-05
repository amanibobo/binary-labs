import { z } from "zod";
import type { MemberRole } from "./domain";

// Onboarding (decisions.md, "our own onboarding instead of Frigade"): what a person has seen is
// stored per user; the checklist is worked out from what the lab has done.

export const HINT_IDS = ["check-this", "phone-upload"] as const;
export const HintId = z.enum(HINT_IDS);
export type HintId = z.infer<typeof HintId>;

export type ClipId = "search" | "open" | "fix" | "needs-look" | "upload" | "talk-through" | "video" | "settings";

export type TourEnd = "done" | "skipped";

export type OnboardingState = {
  welcomeSeen: boolean;
  // The furthest step reached, counted from 1; 0 before the first tour.
  tourStep: number;
  tourEnded: { how: TourEnd; at: string } | null;
  checklistHidden: boolean;
  hintsSeen: readonly HintId[];
};

export const FRESH_STATE: OnboardingState = { welcomeSeen: false, tourStep: 0, tourEnded: null, checklistHidden: false, hintsSeen: [] };

// Everything seen and put away: what a page shows when onboarding can't be loaded.
export const QUIET_STATE: OnboardingState = {
  welcomeSeen: true,
  tourStep: 0,
  tourEnded: { how: "skipped", at: new Date(0).toISOString() },
  checklistHidden: true,
  hintsSeen: HINT_IDS,
};

const Timestamp = z.string().nullable();

// The caller's own row; no row yet means a fresh start. Unknown hint ids (from a newer
// release) are dropped rather than failing the page.
export const OnboardingRows = z
  .array(
    z.object({
      welcome_seen_at: Timestamp,
      tour_step: z.number().int(),
      tour_ended: z.enum(["done", "skipped"]).nullable(),
      tour_ended_at: Timestamp,
      checklist_hidden_at: Timestamp,
      hints_seen: z.array(z.string()),
    }),
  )
  .max(1)
  .transform(([row]): OnboardingState => {
    if (row === undefined) return FRESH_STATE;
    return {
      welcomeSeen: row.welcome_seen_at !== null,
      tourStep: row.tour_step,
      tourEnded: row.tour_ended === null || row.tour_ended_at === null ? null : { how: row.tour_ended, at: row.tour_ended_at },
      checklistHidden: row.checklist_hidden_at !== null,
      hintsSeen: row.hints_seen.flatMap((h) => {
        const hint = HintId.safeParse(h);
        return hint.success ? [hint.data] : [];
      }),
    };
  });

// When each checklist fact first became true, from onboarding_progress; null if it hasn't.
export const ProgressRows = z
  .array(
    z.object({
      joined_at: Timestamp,
      dropbox_at: Timestamp,
      lab_upload_at: Timestamp,
      invited_at: Timestamp,
      protocol_at: Timestamp,
      searched_at: Timestamp,
      corrected_at: Timestamp,
      uploaded_at: Timestamp,
    }),
  )
  .length(1)
  .transform(([row]) => ({
    joinedAt: row.joined_at,
    dropboxAt: row.dropbox_at,
    labUploadAt: row.lab_upload_at,
    invitedAt: row.invited_at,
    protocolAt: row.protocol_at,
    searchedAt: row.searched_at,
    correctedAt: row.corrected_at,
    uploadedAt: row.uploaded_at,
  }));
export type Progress = z.output<typeof ProgressRows>;

export const NO_PROGRESS: Progress = {
  joinedAt: null,
  dropboxAt: null,
  labUploadAt: null,
  invitedAt: null,
  protocolAt: null,
  searchedAt: null,
  correctedAt: null,
  uploadedAt: null,
};

// What the shell hands the client: who's looking, what they've seen, what the lab has done.
export type OnboardingData = { role: MemberRole; state: OnboardingState; progress: Progress; tourHref: string };

// One thing a person did with onboarding, as sent to /api/onboarding and note_onboarding.
export const OnboardingEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("welcome") }),
  z.object({ kind: z.literal("tour_step"), step: z.number().int().min(1).max(20) }),
  z.object({ kind: z.literal("tour_done") }),
  z.object({ kind: z.literal("tour_skipped") }),
  z.object({ kind: z.literal("hint"), hint: HintId }),
  z.object({ kind: z.literal("hide_checklist") }),
]);
export type OnboardingEvent = z.infer<typeof OnboardingEvent>;

export function noteArgs(event: OnboardingEvent): { p_kind: OnboardingEvent["kind"]; p_value: string | null } {
  switch (event.kind) {
    case "tour_step":
      return { p_kind: event.kind, p_value: String(event.step) };
    case "hint":
      return { p_kind: event.kind, p_value: event.hint };
    case "welcome":
    case "tour_done":
    case "tour_skipped":
    case "hide_checklist":
      return { p_kind: event.kind, p_value: null };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

// The same rules as note_onboarding, so the screen updates before the save comes back.
export function applyEvent(state: OnboardingState, event: OnboardingEvent, now: string): OnboardingState {
  switch (event.kind) {
    case "welcome":
      return { ...state, welcomeSeen: true };
    case "tour_step":
      return {
        ...state,
        tourStep: Math.max(state.tourStep, event.step),
        tourEnded: event.step === 1 ? null : state.tourEnded,
      };
    case "tour_done":
      return { ...state, tourEnded: { how: "done", at: now } };
    case "tour_skipped":
      return state.tourEnded?.how === "done" ? state : { ...state, tourEnded: { how: "skipped", at: now } };
    case "hint":
      return state.hintsSeen.includes(event.hint) ? state : { ...state, hintsSeen: [...state.hintsSeen, event.hint] };
    case "hide_checklist":
      return { ...state, checklistHidden: true };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

// ---- Getting started

export type ChecklistAction = { kind: "link"; href: string } | { kind: "tour" };

export type ChecklistItemId = "files" | "invite" | "tour" | "search" | "fix" | "protocol" | "upload";

export type ChecklistItem = { id: ChecklistItemId; label: string; doneAt: string | null; action: ChecklistAction };

type ItemSpec = { label: string; action: ChecklistAction; doneAt: (facts: { progress: Progress; state: OnboardingState }) => string | null };

const earliest = (...times: (string | null)[]): string | null =>
  times.reduce<string | null>((min, t) => (t !== null && (min === null || Date.parse(t) < Date.parse(min)) ? t : min), null);

const ITEMS: Record<ChecklistItemId, ItemSpec> = {
  // A lab that works from uploads alone has its files too.
  files: { label: "Add your lab's files", action: { kind: "link", href: "/lab?area=dropbox" }, doneAt: ({ progress }) => earliest(progress.dropboxAt, progress.labUploadAt) },
  invite: { label: "Invite someone", action: { kind: "link", href: "/lab?area=members" }, doneAt: ({ progress }) => progress.invitedAt },
  tour: { label: "Take the tour", action: { kind: "tour" }, doneAt: ({ state }) => (state.tourEnded?.how === "done" ? state.tourEnded.at : null) },
  search: { label: "Run a search", action: { kind: "link", href: "/" }, doneAt: ({ progress }) => progress.searchedAt },
  fix: { label: "Fix a label", action: { kind: "link", href: "/needs-a-look" }, doneAt: ({ progress }) => progress.correctedAt },
  protocol: { label: "Add a protocol", action: { kind: "link", href: "/protocols/new" }, doneAt: ({ progress }) => progress.protocolAt },
  upload: { label: "Upload a file", action: { kind: "link", href: "/upload" }, doneAt: ({ progress }) => progress.uploadedAt },
};

// The PRD's admin checklist (files, invite, search, protocol) plus an upload; members get the
// things they do day to day.
const CHECKLISTS: Record<MemberRole, readonly ChecklistItemId[]> = {
  admin: ["files", "invite", "search", "protocol", "upload"],
  member: ["tour", "search", "fix", "upload"],
};

export function checklist({ role, progress, state }: { role: MemberRole; progress: Progress; state: OnboardingState }): ChecklistItem[] {
  return CHECKLISTS[role].map((id) => {
    const spec = ITEMS[id];
    return { id, label: spec.label, action: spec.action, doneAt: spec.doneAt({ progress, state }) };
  });
}

export type ChecklistSummary =
  | { kind: "in_progress"; done: number; total: number }
  // completedAt minus joinedAt is the pilot's time to first value.
  | { kind: "complete"; total: number; completedAt: string };

export function summarize(items: readonly ChecklistItem[]): ChecklistSummary {
  const times = items.map((item) => item.doneAt);
  const done = times.filter((t) => t !== null);
  if (done.length < items.length) return { kind: "in_progress", done: done.length, total: items.length };
  const completedAt = done.reduce((max, t) => (Date.parse(t) > Date.parse(max) ? t : max));
  return { kind: "complete", total: items.length, completedAt };
}

export function progressText(summary: ChecklistSummary): string {
  return summary.kind === "complete" ? "Done" : `${summary.done} of ${summary.total}`;
}

// ---- Tour

export type TourStepId = "setup" | "search" | "open" | "fix" | "needs-look";

export type TourStep = {
  id: TourStepId;
  // Tried in order; the first one on screen is spotlit. None on screen centers the step.
  anchors: readonly string[];
  side: "top" | "right" | "bottom" | "left";
  text: string;
  clip: ClipId;
};

// Anchors are data-tour attributes; sidebar links carry their section's name, so Settings is "lab".
const tour = (name: string) => `[data-tour~="${name}"]`;

const TOUR: Record<TourStepId, Omit<TourStep, "id">> = {
  setup: { anchors: [tour("lab"), tour("menu")], side: "right", text: "Connect Dropbox and invite your lab from Settings.", clip: "settings" },
  search: { anchors: [tour("search-box")], side: "bottom", text: "Search for what you remember: a sample, a date, a word inside the file.", clip: "search" },
  open: {
    anchors: [`${tour("results")} > li:first-child`],
    side: "bottom",
    text: "Click a file to see its preview, then open the real file.",
    clip: "open",
  },
  fix: {
    anchors: [`${tour("results")} > li:first-child ${tour("label")}`, `${tour("results")} > li:first-child`],
    side: "bottom",
    text: "Click a name or tag to fix it. Enter saves, and similar files learn from it.",
    clip: "fix",
  },
  "needs-look": { anchors: [tour("needs-look"), tour("menu")], side: "right", text: "Files we couldn't label wait in Needs a look for you to name.", clip: "needs-look" },
};

// The PRD's member tour; admins see the setup step first.
const MEMBER_TOUR: readonly TourStepId[] = ["search", "open", "fix", "needs-look"];

export function tourSteps(role: MemberRole): TourStep[] {
  const ids = role === "admin" ? ["setup" as const, ...MEMBER_TOUR] : MEMBER_TOUR;
  return ids.map((id) => ({ id, ...TOUR[id] }));
}

export function stepCount(index: number, total: number): string {
  return `${index + 1} of ${total}`;
}

// ---- Hints

export type Hint = { id: HintId; anchor: string; text: string; coarseOnly: boolean };

export const HINTS: readonly Hint[] = [
  {
    id: "check-this",
    anchor: '[data-hint~="check-this"]',
    text: "Check this means we're not sure about this label. Click it to say it looks right, or fix the name or tag.",
    coarseOnly: false,
  },
  {
    id: "phone-upload",
    anchor: '[data-hint~="upload-done"]',
    text: "It's in the lab now. Anyone can find it in search by what's in the photo.",
    coarseOnly: true,
  },
];

// ---- How do I…

export type HelpAnswerId = "open-file" | "fix-label" | "needs-look" | "upload" | "talk-through" | "video";

export type HelpAnswer = { id: HelpAnswerId; question: string; answer: string; clip: ClipId };

export const HELP_ANSWERS: readonly HelpAnswer[] = [
  {
    id: "open-file",
    question: "Open the real file",
    answer: "Click a search result to see its preview, then Open in Dropbox. A file uploaded here opens with Open file.",
    clip: "open",
  },
  {
    id: "fix-label",
    question: "Fix a label",
    answer: "Click the name or a tag on any file, type, and press Enter. Similar files learn from what you fix.",
    clip: "fix",
  },
  {
    id: "needs-look",
    question: "Find files that need a look",
    answer: "Needs a look lists the files we couldn't label. Say what each one is and it leaves the list.",
    clip: "needs-look",
  },
  {
    id: "upload",
    question: "Upload from the bench",
    answer: "Open Upload on your phone and take a photo or pick files. They're labeled and searchable within a minute.",
    clip: "upload",
  },
  {
    id: "talk-through",
    question: "Record a talk-through",
    answer: "On a protocol, choose Record a talk-through and say the steps as you work. You review the written steps before they're saved.",
    clip: "talk-through",
  },
  {
    id: "video",
    question: "Add a video to a protocol",
    answer: "On a protocol, choose Add a video to record one with your phone, pick a file, or link a video already in the lab.",
    clip: "video",
  },
];
