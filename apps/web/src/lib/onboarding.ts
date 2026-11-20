import { z } from "zod";
import type { MemberRole } from "./domain";

// Onboarding (decisions.md, "our own onboarding instead of Frigade"): what a person has seen is
// stored per user; the checklist is worked out from what the lab has done.

export const HINT_IDS = ["check-this", "phone-upload"] as const;
export const HintId = z.enum(HINT_IDS);
export type HintId = z.infer<typeof HintId>;

// Clips are recorded by scripts/record-clips.mjs; clip-sizes.ts lists them all.
export type ClipId =
  | "ask"
  | "search"
  | "browse"
  | "protocols"
  | "map"
  | "calendar"
  | "calendar-views"
  | "needs-look"
  | "flags"
  | "upload"
  | "settings"
  | "help"
  | "open"
  | "fix"
  | "talk-through"
  | "video"
  | "chart"
  | "chart-wells"
  | "chart-curve"
  | "chart-ic50"
  | "invite";

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
  files: { label: "Add your lab's files", action: { kind: "link", href: "/settings/dropbox" }, doneAt: ({ progress }) => earliest(progress.dropboxAt, progress.labUploadAt) },
  invite: { label: "Invite someone", action: { kind: "link", href: "/settings/members" }, doneAt: ({ progress }) => progress.invitedAt },
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

// One step per tab, in the sidebar's order, ending on Help where the tour can be taken again.
export const TOUR_STEP_IDS = ["search", "browse", "protocols", "map", "calendar", "needs-look", "flags", "upload", "settings", "help"] as const;
export type TourStepId = (typeof TOUR_STEP_IDS)[number];

export type TourStep = {
  id: TourStepId;
  // Tried in order; the first one on screen is spotlit. None on screen centers the step.
  anchors: readonly string[];
  // The tab's name as the sidebar shows it.
  title: string;
  // What the tab is for, then when you'd use it: one short sentence each.
  what: string;
  when: string;
  clip: ClipId;
};

// Anchors are data-tour attributes. Sidebar links carry their section's name, so Settings (at
// /settings) is "lab"; on a phone the sidebar is behind the menu button, which stands in for it.
const tour = (name: string) => `[data-tour~="${name}"]`;
const inSidebar = (section: string) => [tour(section), tour("menu")];

type StepCopy = Omit<TourStep, "id">;

const TOUR: Record<TourStepId, StepCopy> = {
  // On a phone the Search home's box is on screen, so it's spotlit rather than the menu.
  search: {
    anchors: [tour("search"), tour("search-box"), tour("menu")],
    title: "Search",
    what: "Find any file by what's in it, or ask a question and get an answer that links to its sources.",
    when: "To ask, type a question, like “What was the yield of batch 3?”, and press Enter.",
    clip: "ask",
  },
  browse: {
    anchors: inSidebar("browse"),
    title: "Browse",
    what: "The lab's folders, the way they're organized in Dropbox.",
    when: "Use it when you know which folder a file is in.",
    clip: "browse",
  },
  protocols: {
    anchors: inSidebar("protocols"),
    title: "Protocols",
    what: "The lab's step-by-step methods, with versions, videos and talk-throughs.",
    when: "Start here when you learn a technique, like running a gel.",
    clip: "protocols",
  },
  map: {
    anchors: inSidebar("map"),
    title: "Map",
    what: "How files, experiments, people and instruments connect.",
    when: "To see all of one experiment or person in one place, click its dot.",
    clip: "map",
  },
  calendar: {
    anchors: inSidebar("calendar"),
    title: "Calendar",
    what: "What happened each day, and the lab's plans.",
    when: "To book the plate reader, choose New entry and pick it as the instrument.",
    clip: "calendar",
  },
  "needs-look": {
    anchors: inSidebar("needs-look"),
    title: "Needs a look",
    what: "Files Binary couldn't label, like a photo with no name.",
    when: "Say what one is in a line, and it learns.",
    clip: "needs-look",
  },
  flags: {
    anchors: inSidebar("flags"),
    title: "Flags",
    what: "Results outside what a protocol expects, each showing where it came from.",
    when: "Look here when a result seems wrong, and say if the flag was right.",
    clip: "flags",
  },
  upload: {
    anchors: inSidebar("upload"),
    title: "Upload",
    what: "Add a photo, file or voice recording from your phone or computer.",
    when: "At the bench, a gel photo is searchable within a minute.",
    clip: "upload",
  },
  settings: {
    anchors: inSidebar("lab"),
    title: "Settings",
    what: "Dropbox, instruments, experiments and people.",
    when: "Mostly set up for you; your own account and appearance are here too.",
    clip: "settings",
  },
  help: {
    anchors: inSidebar("help"),
    title: "Help",
    what: "Replay this tour, or read how to do something.",
    when: "Open it whenever you're stuck.",
    clip: "help",
  },
};

// Admins set the lab up, so their Settings step says so.
const ADMIN_SETTINGS_WHEN = "Start here to connect Dropbox and invite your lab.";

export function tourSteps(role: MemberRole): TourStep[] {
  return TOUR_STEP_IDS.map((id) => {
    const copy = TOUR[id];
    const when = id === "settings" && role === "admin" ? ADMIN_SETTINGS_WHEN : copy.when;
    return { id, ...copy, when };
  });
}

export function stepCount(index: number, total: number): string {
  return `${index + 1} of ${total}`;
}

// After a finished tour (not a skipped one), one quiet line by Protocols says where to begin.
export const START_POINTER = {
  anchors: inSidebar("protocols"),
  text: "New here? Start with Protocols to learn a technique, or Search to find something.",
} as const;

// ---- Hints

export type Hint = { id: HintId; anchor: string; text: string; coarseOnly: boolean };

export const HINTS: readonly Hint[] = [
  {
    id: "check-this",
    anchor: '[data-hint~="check-this"]',
    text: "Check this means these labels were a guess. Open the file to confirm them, or fix what's wrong under Labels.",
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

export const HELP_GROUPS = [
  { id: "find", title: "Finding things" },
  { id: "protocols", title: "Protocols" },
  { id: "day", title: "Plans, results and uploads" },
  { id: "charts", title: "Charts" },
  { id: "lab", title: "Your lab" },
] as const;
export type HelpGroupId = (typeof HELP_GROUPS)[number]["id"];

export type HelpAnswerId =
  | "ask"
  | "old-questions"
  | "filter"
  | "keys"
  | "open-file"
  | "fix-label"
  | "many-labels"
  | "repeat"
  | "needs-look"
  | "map"
  | "learn"
  | "talk-through"
  | "video"
  | "checks"
  | "calendar"
  | "flag"
  | "upload"
  | "chart"
  | "wells"
  | "standard-curve"
  | "ic50"
  | "test"
  | "runs"
  | "run-history"
  | "export"
  | "invite"
  | "members"
  | "instrument";

// A clip where seeing it helps; a few answers are clear in words alone.
export type HelpAnswer = { id: HelpAnswerId; group: HelpGroupId; question: string; answer: string; clip: ClipId | null };

export const HELP_ANSWERS: readonly HelpAnswer[] = [
  {
    id: "ask",
    group: "find",
    question: "Ask the lab a question",
    answer: "Type a question in Search, like “What wavelength is the Bradford read at?”, and press Enter. The answer says which files and protocols it came from; click a number to open one.",
    clip: "ask",
  },
  {
    id: "old-questions",
    group: "find",
    question: "Find a question asked before",
    answer: "On Search, choose Show all questions under Recent questions and type a word from the question or its answer. Click one to read its answer again.",
    clip: null,
  },
  {
    id: "filter",
    group: "find",
    question: "Find failed runs or labels to check",
    answer: "Choose Filters in the search box and pick an outcome, like Failed or A repeat, or Check this only for labels Binary guessed. Each filter shows as a chip; click its × to remove it.",
    clip: null,
  },
  {
    id: "keys",
    group: "find",
    question: "Use the keyboard in Search",
    answer: "Press ↓ from the search box to move through the files, Enter to open one and Esc to close it. On a file, E edits its labels, C makes a chart from a data sheet and X picks it.",
    clip: null,
  },
  {
    id: "open-file",
    group: "find",
    question: "Open the real file",
    answer: "Click a search result to see its preview, then Open in Dropbox. A file uploaded here opens with Open file.",
    clip: "open",
  },
  {
    id: "fix-label",
    group: "find",
    question: "Fix a label",
    answer: "Click a file to open it, choose Edit labels (or press E on the file), click the value to change, type and press Enter. Similar files learn from what you fix.",
    clip: "fix",
  },
  {
    id: "many-labels",
    group: "find",
    question: "Change labels on many files",
    answer: "Choose Select by the list in Search or Browse, tick the files, then pick what to change, like the experiment. It says how many files change before you apply, and Undo puts them all back.",
    clip: null,
  },
  {
    id: "repeat",
    group: "find",
    question: "Link a repeat to its run",
    answer: "Open the repeat, choose Edit labels and mark it A repeat, then Pick the run it repeats. Each run then links to the other.",
    clip: null,
  },
  {
    id: "needs-look",
    group: "find",
    question: "Find files that need a look",
    answer: "Needs a look lists the files Binary isn't sure about. Say what each one is in a line and it leaves the list.",
    clip: "needs-look",
  },
  {
    id: "map",
    group: "find",
    question: "Read the map",
    answer: "Each dot is a protocol, experiment, person or instrument, bigger when it holds more files, and a line means two share files. Click a dot to show its files, or Show as a list to read the same thing as text.",
    clip: "map",
  },
  {
    id: "learn",
    group: "protocols",
    question: "Learn a technique",
    answer: "Open Protocols and pick the method, like SDS-PAGE. It has the steps, every past version, and any videos and talk-throughs the lab added.",
    clip: "protocols",
  },
  {
    id: "talk-through",
    group: "protocols",
    question: "Record a talk-through",
    answer: "On a protocol, choose Record a talk-through and say the steps as you work. You review the written steps before they're saved.",
    clip: "talk-through",
  },
  {
    id: "video",
    group: "protocols",
    question: "Add a video to a protocol",
    answer: "On a protocol, choose Add a video to record one with your phone, pick a file, or link a video already in the lab.",
    clip: "video",
  },
  {
    id: "checks",
    group: "protocols",
    question: "Check results as they arrive",
    answer: "On a protocol, choose Add a check, such as a standard curve's R², an IC50, samples outside the standards, or blanks named in a row or column. Files tied to the protocol are checked, and a result out of range is flagged.",
    clip: null,
  },
  {
    id: "calendar",
    group: "day",
    question: "Use the calendar",
    answer: "Drag down empty time, or choose New entry, to plan something like booking the plate reader; it saves as you type. Day, Week, Month and Year change the view, and clicking the month's name jumps to any month.",
    clip: "calendar-views",
  },
  {
    id: "flag",
    group: "day",
    question: "Answer a flag",
    answer: "Open a flag in Flags to see the value, the range it was checked against and the protocol it came from. Say whether it was Useful, Wrong or a Known issue; Wrong lets you fix the check's range.",
    clip: "flags",
  },
  {
    id: "upload",
    group: "day",
    question: "Upload from the bench",
    answer: "Open Upload on your phone and take a photo or pick files. They're labeled and searchable within a minute.",
    clip: "upload",
  },
  {
    id: "chart",
    group: "charts",
    question: "Make a chart from a data sheet",
    answer: "Open a spreadsheet or CSV in Search, choose Make a chart, and pick what you want to show. It draws itself from your columns; click a title or a line to change it, then Save.",
    clip: "chart",
  },
  {
    id: "wells",
    group: "charts",
    question: "Mark the wells on a plate",
    answer: "Choose Mark the wells, drag across some wells, pick Blank, Control, Standard or Sample, and choose Mark. Wells marked the same way count as repeats.",
    clip: "chart-wells",
  },
  {
    id: "standard-curve",
    group: "charts",
    question: "Read unknowns off a standard curve",
    answer: "With your standards and samples marked, pick How two measurements relate. A line is fitted to the standards and each sample is read off it into a table under the chart, its dilution included.",
    clip: "chart-curve",
  },
  {
    id: "ic50",
    group: "charts",
    question: "Get an IC50",
    answer: "With the doses marked, pick How a dose changes the effect. Binary fits the curve and shows the IC50 on it, with its 95% range under the chart.",
    clip: "chart-ic50",
  },
  {
    id: "test",
    group: "charts",
    question: "Check if a difference is real",
    answer: "Pick Compare groups and Binary chooses a test and says why, under Could the difference be chance? It gives the answer in plain words first, then the p value.",
    clip: null,
  },
  {
    id: "runs",
    group: "charts",
    question: "Put several runs on one chart",
    answer: "On a line or scatter chart, choose Add runs and pick other files, or add all of the experiment. Each is drawn with the same columns; a run labeled failed is gray and dashed.",
    clip: null,
  },
  {
    id: "run-history",
    group: "charts",
    question: "See a check across runs",
    answer: "On a protocol page, choose Across runs beside a check. Each run is a point against the allowed range; flagged runs are amber and failed runs a gray ring.",
    clip: null,
  },
  {
    id: "export",
    group: "charts",
    question: "Export a chart for a paper",
    answer: "Choose Download, pick Single journal column (85 mm) or Double column (180 mm), then PDF or SVG. The numbers behind the chart come as a CSV.",
    clip: null,
  },
  {
    id: "invite",
    group: "lab",
    question: "Invite someone",
    answer: "Choose Invite people above Settings and type their email; they get a link to sign in. Only admins invite, so ask yours if you don't see it.",
    clip: "invite",
  },
  {
    id: "members",
    group: "lab",
    question: "Remove someone or make them an admin",
    answer: "In Settings, Members, an admin picks Admin or Member beside a person, or chooses Remove, which deletes nothing they made. A lab always keeps one admin.",
    clip: null,
  },
  {
    id: "instrument",
    group: "lab",
    question: "Connect an instrument PC",
    answer: "In Settings, Instruments, choose Get the Windows uploader and the setup steps. An admin adds the instrument, gets a pairing code and runs the uploader on its PC; new files then show up under Browse in Instruments.",
    clip: null,
  },
];

// The answers under each group's title, in the order above; a group with none is left out.
export function helpGroups(): { id: HelpGroupId; title: string; answers: HelpAnswer[] }[] {
  return HELP_GROUPS.map((g) => ({ ...g, answers: HELP_ANSWERS.filter((a) => a.group === g.id) })).filter((g) => g.answers.length > 0);
}
