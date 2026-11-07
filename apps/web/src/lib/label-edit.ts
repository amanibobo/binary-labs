import type { CorrectionId, Sha256 } from "./ids";
import type { Experiment, ExperimentRef, Label, LabelCondition, LabelDetails, LabelOutcome, NoteKind, Person, PersonRef } from "./domain";

export type LabLists = { experiments: readonly Experiment[]; people: readonly Person[] };

// What correct_label takes: the name and every detail it sets (the six old fields, and the outcome,
// summary, conditions and kind of note in p_more).
export type LabelDraft = LabelDetails & { cleanName: string };

export type TagRef =
  | { kind: "date" }
  | { kind: "experiment" }
  | { kind: "person" }
  | { kind: "instrument" }
  | { kind: "free"; index: number };

export type LabelEdit =
  | { kind: "rename"; text: string }
  // Empty text clears the tag.
  | { kind: "set"; tag: TagRef; text: string }
  | { kind: "remove"; tag: TagRef }
  | { kind: "add"; text: string }
  | { kind: "outcome"; outcome: LabelOutcome | null }
  | { kind: "noteKind"; noteKind: NoteKind | null }
  // Empty text clears the summary.
  | { kind: "summary"; text: string }
  // A condition's value; empty text takes the condition off.
  | { kind: "condition"; index: number; text: string }
  // The answer to a voice note's question: an experiment id or a YYYY-MM-DD day.
  | { kind: "answer"; field: "experiment" | "date"; value: string };

export type EditResult = { kind: "changed"; draft: LabelDraft } | { kind: "unchanged" } | { kind: "invalid"; message: string };

// Limits from the labels table's checks, so a bad edit fails here instead of in the database.
const MAX_NAME = 200;
const MAX_INSTRUMENT = 120;
const MAX_TAGS = 20;
const MAX_SUMMARY = 400;
const MAX_VALUE = 80;

const DATE_HINT = "Use a date like 2026-10-14 or Oct 14 2026.";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthNumber(word: string): number | null {
  const w = word.toLowerCase();
  if (w.length < 3) return null;
  const index = MONTHS.findIndex((m) => m.startsWith(w));
  return index === -1 ? null : index + 1;
}

function isoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

export type DateParse = { kind: "date"; date: string | null } | { kind: "invalid"; message: string };

// Accepts 2026-10-14, Oct 14 2026 and 14 Oct 2026 (full month names, commas and "14th"
// too). Empty clears the date.
export function parseDate(text: string): DateParse {
  const t = text.trim().replace(/\s+/g, " ");
  if (t === "") return { kind: "date", date: null };
  const invalid: DateParse = { kind: "invalid", message: DATE_HINT };

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso !== null) {
    const date = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return date === null ? invalid : { kind: "date", date };
  }
  const monthFirst = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/i.exec(t);
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?,? (\d{4})$/i.exec(t);
  const parts =
    monthFirst !== null
      ? { month: monthFirst[1], day: monthFirst[2], year: monthFirst[3] }
      : dayFirst !== null
        ? { month: dayFirst[2], day: dayFirst[1], year: dayFirst[3] }
        : null;
  if (parts === null) return invalid;
  const month = monthNumber(parts.month ?? "");
  if (month === null) return invalid;
  const date = isoDate(Number(parts.year), month, Number(parts.day));
  return date === null ? invalid : { kind: "date", date };
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export type Match<T> = { kind: "found"; item: T } | { kind: "none" } | { kind: "ambiguous"; names: string[] };

// Whole-name matches only, case-insensitive. A name beats an alias, so "BM3" finds the
// experiment called BM3 even when another lists BM3 as an alias.
export function matchByName<T extends { name: string; aliases: readonly string[] }>(text: string, items: readonly T[]): Match<T> {
  const wanted = norm(text);
  if (wanted === "") return { kind: "none" };
  for (const pool of [
    items.filter((i) => norm(i.name) === wanted),
    items.filter((i) => i.aliases.some((a) => norm(a) === wanted)),
  ]) {
    const [first, ...rest] = pool;
    if (first === undefined) continue;
    return rest.length === 0 ? { kind: "found", item: first } : { kind: "ambiguous", names: pool.map((i) => i.name) };
  }
  return { kind: "none" };
}

function matchMessage(match: Match<unknown>, text: string, noun: string): string {
  return match.kind === "ambiguous"
    ? `“${text.trim()}” matches more than one ${noun}: ${match.names.join(", ")}.`
    : `No ${noun} called “${text.trim()}”. Add it in Settings first.`;
}

type FieldResult<T> = { kind: "ok"; value: T } | { kind: "invalid"; message: string };

function experimentFrom(text: string, lists: LabLists): FieldResult<ExperimentRef | null> {
  if (text.trim() === "") return { kind: "ok", value: null };
  const match = matchByName(text, lists.experiments);
  return match.kind === "found"
    ? { kind: "ok", value: { id: match.item.id, name: match.item.name } }
    : { kind: "invalid", message: matchMessage(match, text, "experiment") };
}

function personFrom(text: string, lists: LabLists): FieldResult<PersonRef | null> {
  if (text.trim() === "") return { kind: "ok", value: null };
  const match = matchByName(text, lists.people);
  return match.kind === "found"
    ? { kind: "ok", value: { id: match.item.id, name: match.item.name } }
    : { kind: "invalid", message: matchMessage(match, text, "person") };
}

function instrumentFrom(text: string): FieldResult<string | null> {
  const t = text.trim();
  if (t.length > MAX_INSTRUMENT) return { kind: "invalid", message: `Keep the instrument under ${MAX_INSTRUMENT} characters.` };
  return { kind: "ok", value: t === "" ? null : t };
}

// The database trims tags, drops empty ones and keeps the first of any repeats.
function cleanTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter((t) => t !== ""))];
}

function detailsOf(label: Label): LabelDetails {
  const { date, experiment, person, instrument, tags, outcome, summary, conditions, noteKind } = label;
  return { date, experiment, person, instrument, tags, outcome, summary, conditions, noteKind };
}

export function draftOf(label: Label): LabelDraft | null {
  if (label.status === "needs_look") return null;
  return { ...detailsOf(label), cleanName: label.cleanName };
}

const sameCondition = (a: LabelCondition, b: LabelCondition) =>
  a.kind === b.kind && a.what === b.what && a.value === b.value && a.unit === b.unit;

function sameDraft(a: LabelDraft, b: LabelDraft): boolean {
  return (
    a.cleanName === b.cleanName &&
    a.date === b.date &&
    a.experiment?.id === b.experiment?.id &&
    a.person?.id === b.person?.id &&
    a.instrument === b.instrument &&
    a.tags.length === b.tags.length &&
    a.tags.every((t, i) => t === b.tags[i]) &&
    a.outcome === b.outcome &&
    a.summary === b.summary &&
    a.noteKind === b.noteKind &&
    a.conditions.length === b.conditions.length &&
    a.conditions.every((c, i) => {
      const other = b.conditions[i];
      return other !== undefined && sameCondition(c, other);
    })
  );
}

// A condition's new value as typed: its unit dropped when typed again ("50 µM" for a µM value).
function conditionValue(c: LabelCondition, text: string): FieldResult<string | null> {
  let t = text.trim().replace(/\s+/g, " ");
  if (c.unit !== null && t.toLowerCase().endsWith(c.unit.toLowerCase())) t = t.slice(0, -c.unit.length).trim();
  if (t.length > MAX_VALUE) return { kind: "invalid", message: `Keep a value under ${MAX_VALUE} characters.` };
  return { kind: "ok", value: t === "" ? null : t };
}

// The smart fields: an outcome, a kind of note, the summary, one condition, or a voice note's answer.
function setSmart(details: LabelDetails, edit: SmartEdit, lists: LabLists): FieldResult<LabelDetails> {
  switch (edit.kind) {
    case "outcome":
      return { kind: "ok", value: { ...details, outcome: edit.outcome } };
    case "noteKind":
      return { kind: "ok", value: { ...details, noteKind: edit.noteKind } };
    case "summary": {
      const t = edit.text.trim().replace(/\s+/g, " ");
      if (t.length > MAX_SUMMARY) return { kind: "invalid", message: `Keep the summary under ${MAX_SUMMARY} characters.` };
      return { kind: "ok", value: { ...details, summary: t === "" ? null : t } };
    }
    case "condition": {
      const current = details.conditions[edit.index];
      if (current === undefined) return { kind: "invalid", message: "That condition isn't there any more." };
      const parsed = conditionValue(current, edit.text);
      if (parsed.kind === "invalid") return parsed;
      const conditions =
        parsed.value === null && edit.text.trim() === ""
          ? details.conditions.filter((_, i) => i !== edit.index)
          : details.conditions.map((c, i) => (i === edit.index ? { ...c, value: parsed.value } : c));
      return { kind: "ok", value: { ...details, conditions } };
    }
    case "answer": {
      if (edit.field === "date") {
        const parsed = parseDate(edit.value);
        return parsed.kind === "date" && parsed.date !== null ? { kind: "ok", value: { ...details, date: parsed.date } } : { kind: "invalid", message: DATE_HINT };
      }
      const found = lists.experiments.find((e) => e.id === edit.value);
      return found === undefined
        ? { kind: "invalid", message: "That experiment isn't in the lab any more." }
        : { kind: "ok", value: { ...details, experiment: { id: found.id, name: found.name } } };
    }
    default: {
      const _exhaustive: never = edit;
      return _exhaustive;
    }
  }
}

type SmartEdit = Extract<LabelEdit, { kind: "outcome" | "noteKind" | "summary" | "condition" | "answer" }>;

function setTag(details: LabelDetails, tag: TagRef, text: string, lists: LabLists): FieldResult<LabelDetails> {
  switch (tag.kind) {
    case "date": {
      const parsed = parseDate(text);
      return parsed.kind === "date" ? { kind: "ok", value: { ...details, date: parsed.date } } : parsed;
    }
    case "experiment": {
      const parsed = experimentFrom(text, lists);
      return parsed.kind === "ok" ? { kind: "ok", value: { ...details, experiment: parsed.value } } : parsed;
    }
    case "person": {
      const parsed = personFrom(text, lists);
      return parsed.kind === "ok" ? { kind: "ok", value: { ...details, person: parsed.value } } : parsed;
    }
    case "instrument": {
      const parsed = instrumentFrom(text);
      return parsed.kind === "ok" ? { kind: "ok", value: { ...details, instrument: parsed.value } } : parsed;
    }
    case "free":
      return { kind: "ok", value: { ...details, tags: cleanTags(details.tags.map((t, i) => (i === tag.index ? text : t))) } };
    default: {
      const _exhaustive: never = tag;
      return _exhaustive;
    }
  }
}

// A new tag fills an empty date, experiment or person when the text is one; anything
// else is a free tag.
function addTag(details: LabelDetails, text: string, lists: LabLists): FieldResult<LabelDetails> {
  const t = text.trim();
  if (t === "") return { kind: "ok", value: details };
  if (details.date === null) {
    const parsed = parseDate(t);
    if (parsed.kind === "date") return { kind: "ok", value: { ...details, date: parsed.date } };
  }
  if (details.experiment === null) {
    const match = matchByName(t, lists.experiments);
    if (match.kind === "found") return { kind: "ok", value: { ...details, experiment: { id: match.item.id, name: match.item.name } } };
  }
  if (details.person === null) {
    const match = matchByName(t, lists.people);
    if (match.kind === "found") return { kind: "ok", value: { ...details, person: { id: match.item.id, name: match.item.name } } };
  }
  const tags = cleanTags([...details.tags, t]);
  if (tags.length > MAX_TAGS) return { kind: "invalid", message: `A file can have up to ${MAX_TAGS} tags.` };
  return { kind: "ok", value: { ...details, tags } };
}

export function applyEdit({ label, edit, lists }: { label: Label; edit: LabelEdit; lists: LabLists }): EditResult {
  const current = draftOf(label);
  const details = detailsOf(label);

  let next: LabelDraft;
  switch (edit.kind) {
    case "rename": {
      const name = edit.text.trim().replace(/\s+/g, " ");
      if (name === "") return { kind: "invalid", message: "A label needs a name." };
      if (name.length > MAX_NAME) return { kind: "invalid", message: `Keep the name under ${MAX_NAME} characters.` };
      next = { ...details, cleanName: name };
      break;
    }
    case "set":
    case "remove":
    case "add": {
      if (current === null) return { kind: "invalid", message: "Give the file a name first." };
      const result =
        edit.kind === "add"
          ? addTag(details, edit.text, lists)
          : setTag(details, edit.tag, edit.kind === "set" ? edit.text : "", lists);
      if (result.kind === "invalid") return result;
      next = { ...result.value, cleanName: current.cleanName };
      break;
    }
    case "outcome":
    case "noteKind":
    case "summary":
    case "condition":
    case "answer": {
      if (current === null) return { kind: "invalid", message: "Give the file a name first." };
      const result = setSmart(details, edit, lists);
      if (result.kind === "invalid") return result;
      next = { ...result.value, cleanName: current.cleanName };
      break;
    }
    default: {
      const _exhaustive: never = edit;
      return _exhaustive;
    }
  }
  return current !== null && sameDraft(current, next) ? { kind: "unchanged" } : { kind: "changed", draft: next };
}

// What the database will store for a draft, shown before it answers. Same values as
// before is an acceptance, as in corrections_apply.
// A person's correction also settles what Binary was unsure of (the other titles, what it
// couldn't read), and answers a voice note's question once its field is set.
export function optimisticLabel(label: Label, draft: LabelDraft): Label {
  const current = draftOf(label);
  const accepted = current !== null && sameDraft(current, draft);
  const q = label.followUp;
  const answered = q !== null && (q.field === "experiment" ? draft.experiment !== null : draft.date !== null);
  return {
    ...draft,
    alternatives: [],
    unclear: [],
    followUp: answered ? null : q,
    note: label.note,
    status: accepted ? "accepted" : "corrected",
    confidence: 1,
  };
}

export type TagView = { ref: TagRef; text: string; key: string };

export function labelTags(label: Label, formatDate: (iso: string) => string): TagView[] {
  const views: TagView[] = [];
  if (label.date !== null) views.push({ ref: { kind: "date" }, text: formatDate(label.date), key: "date" });
  if (label.experiment !== null) views.push({ ref: { kind: "experiment" }, text: label.experiment.name, key: "experiment" });
  if (label.person !== null) views.push({ ref: { kind: "person" }, text: label.person.name, key: "person" });
  if (label.instrument !== null) views.push({ ref: { kind: "instrument" }, text: label.instrument, key: "instrument" });
  label.tags.forEach((text, index) => views.push({ ref: { kind: "free", index }, text, key: `tag:${text}` }));
  return views;
}

export function sameLabel(a: Label | null, b: Label | null): boolean {
  if (a === null || b === null) return a === b;
  return a.status === b.status && sameDraft({ ...a, cleanName: a.cleanName ?? "" }, { ...b, cleanName: b.cleanName ?? "" });
}

export type UndoEntry = { correctionId: CorrectionId; sha256: Sha256; before: Label; after: Label };

// An undo restores what its correction replaced, and only while the file still shows
// what that correction produced; after a later edit the database refuses it too.
export function undoTarget(entry: UndoEntry, showing: Label | null): Label | null {
  return sameLabel(showing, entry.after) ? entry.before : null;
}

// A failed save puts the old label back, unless a newer edit has replaced it on screen.
export function revertTarget({ showing, optimistic, before }: { showing: Label | null; optimistic: Label; before: Label }): Label | null {
  return sameLabel(showing, optimistic) ? before : null;
}

export function needsLookDelta(before: Label | null, after: Label | null): -1 | 0 | 1 {
  const was = before?.status === "needs_look";
  const is = after?.status === "needs_look";
  return was === is ? 0 : is ? 1 : -1;
}
