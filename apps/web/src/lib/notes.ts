import { z } from "zod";
import { NoteId, type FileHit, type NoteInfo, type NotePage } from "./domain";
import { Sha256, type LabId } from "./ids";

// What the browser sends to /api/notes: keep a note Binary suggested, split one back into its
// files (and undo that), take one page out, or join files as one note.
export const NoteRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep"), noteId: NoteId }),
  z.object({ action: z.literal("split"), noteId: NoteId }),
  z.object({ action: z.literal("restore"), noteId: NoteId }),
  z.object({ action: z.literal("remove_page"), noteId: NoteId, sha256: Sha256 }),
  z.object({ action: z.literal("join"), shas: z.array(Sha256).min(2).max(200) }),
]);
export type NoteRequest = z.infer<typeof NoteRequest>;

export type NoteRpc =
  | { fn: "keep_note" | "split_note" | "restore_note"; args: { p_note_id: NoteId } }
  | { fn: "remove_note_page"; args: { p_note_id: NoteId; p_sha256: Sha256 } }
  | { fn: "join_note"; args: { p_lab_id: LabId; p_shas: Sha256[] } };

export function noteRpc(labId: LabId, req: NoteRequest): NoteRpc {
  switch (req.action) {
    case "keep":
      return { fn: "keep_note", args: { p_note_id: req.noteId } };
    case "split":
      return { fn: "split_note", args: { p_note_id: req.noteId } };
    case "restore":
      return { fn: "restore_note", args: { p_note_id: req.noteId } };
    case "remove_page":
      return { fn: "remove_note_page", args: { p_note_id: req.noteId, p_sha256: req.sha256 } };
    case "join":
      return { fn: "join_note", args: { p_lab_id: labId, p_shas: req.shas } };
    default: {
      const _exhaustive: never = req;
      return _exhaustive;
    }
  }
}

// The functions raise these (0025_smart_labels.sql); everything else is our fault.
export function noteFailure(error: { code?: string }): { status: number; message: string } {
  switch (error.code) {
    case "BL701":
      return { status: 400, message: "Pick two or more files to join." };
    case "BL702":
      return { status: 400, message: "One of those files isn't in this lab." };
    case "BL703":
      return { status: 409, message: "Those files are pages of different notes. Split one first." };
    case "BL704":
      return { status: 404, message: "That note isn't there any more." };
    case "BL705":
      return { status: 409, message: "A page is in another note now, so the split can't be undone." };
    case "BL706":
      return { status: 409, message: "That page isn't in this note any more." };
    case "42501":
      return { status: 403, message: "You're not a member of this lab." };
    default:
      return { status: 500, message: "We couldn't change that note. Try again." };
  }
}

// A list of files with each note shown once where the first of its pages appeared: as its first
// page (which carries the note's label) when that's in `covers` or the list, else as the first
// of its pages the list holds.
export function collapseNotes(hits: readonly FileHit[], covers: readonly FileHit[]): FileHit[] {
  const bySha = new Map([...hits, ...covers].map((c) => [c.sha256, c]));
  const seen = new Set<string>();
  const out: FileHit[] = [];
  for (const hit of hits) {
    const note = hit.label?.note ?? null;
    const key = note === null ? hit.sha256 : note.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(note === null ? hit : (bySha.get(note.pages[0].sha256) ?? hit));
  }
  return out;
}

// The first pages a list needs to show its notes, which it doesn't hold yet.
export function missingCovers(hits: readonly FileHit[]): Sha256[] {
  const held = new Set(hits.map((h) => h.sha256));
  const wanted = hits.flatMap((h) => (h.label?.note == null ? [] : [h.label.note.pages[0].sha256]));
  return [...new Set(wanted)].filter((sha) => !held.has(sha));
}

// The page a note opens at: the one a search matched, else the first.
export function openingPage(note: NoteInfo, matched: number | null | undefined): NotePage {
  return note.pages.find((p) => p.position === matched) ?? note.pages[0];
}

export const PAGE_ROLE_NAMES: Record<NotePage["role"], string> = {
  setup: "Setup",
  readings: "Readings",
  reflection: "Reflection",
  other: "Other",
};

// "Page 7 of 12 · Readings": where a reader is in a note.
export function pageCaption(note: NoteInfo, page: NotePage): string {
  const role = page.role === "other" ? "" : ` · ${PAGE_ROLE_NAMES[page.role]}`;
  return `Page ${page.position} of ${note.pages.length}${role}`;
}

// A note without the page a person took out, its later pages moved up, as remove_note_page
// leaves it; null once one page is left, since a note of one page is split.
export function withoutPage(note: NoteInfo, sha: Sha256): NoteInfo | null {
  const kept = note.pages.filter((p) => p.sha256 !== sha).map((p, i) => ({ ...p, position: i + 1 }));
  const [first, ...rest] = kept;
  if (first === undefined || rest.length === 0) return null;
  return { ...note, state: "confirmed", pages: [first, ...rest] };
}
