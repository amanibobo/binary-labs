import { z } from "zod";
import { ProtocolId, ProtocolVersionId } from "./ids";
import { plainText } from "./protocols";
import { fromRow, type PlanFields } from "./run-record";
import { diffLines } from "./text-diff";

// Planned versus actual (decisions.md, "the run record: planned versus actual"): the protocol
// as written, the text of what was actually done, and the plain list of what changed.

export const AS_RUN_MAX = 200_000;

// A version a run's protocol can be (run_plan_choices), in the order to offer them.
export const PlanChoice = z.object({
  versionId: ProtocolVersionId,
  protocolId: ProtocolId,
  title: z.string(),
  version: z.number().int(),
  savedAt: z.string(),
  // The protocol's newest version; the newest saved by the run's day; the one picked now.
  current: z.boolean(),
  suggested: z.boolean(),
  picked: z.boolean(),
});
export type PlanChoice = z.infer<typeof PlanChoice>;
export const PlanChoicesJson = fromRow(z.array(PlanChoice));

// The texts the difference is drawn from (run_plan_bodies): the picked version's, and the
// version's the as-run text started from.
export const PlanBodies = z.object({
  planned: z.string().nullable(),
  basedOn: z.object({ versionId: ProtocolVersionId, title: z.string(), version: z.number().int(), body: z.string() }).nullable(),
});
export type PlanBodies = z.infer<typeof PlanBodies>;
export const PlanBodiesJson = fromRow(PlanBodies);

export const SetPlanRequest = z.object({ versionId: ProtocolVersionId.nullable() });
export const SaveAsRunRequest = z.object({
  body: z.string().max(AS_RUN_MAX, "That's too long to save. Keep what was done under 200,000 characters."),
  basedOn: ProtocolVersionId.nullable(),
});

// ---- A protocol's text as lines a student edits one at a time.

// `lead` is the Markdown before the words (indent, bullet, "> "); a step's number isn't kept,
// because steps are numbered again in order when the text is written. A fixed line (a table
// row, code) is kept exactly; a heading is shown, not edited.
export type LineKind = "heading" | "step" | "item" | "text" | "fixed" | "blank";
export type ProtocolLine = { kind: LineKind; lead: string; text: string; number: number | null };

const HEADING = /^(\s{0,3}#{1,6}\s+)(.*)$/;
const STEP = /^(\s*)(\d+)[.)]\s+(.*)$/;
const ITEM = /^(\s*[-*+]\s+)(.*)$/;
const QUOTE = /^(\s{0,3}>\s?)(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export function readLines(body: string): ProtocolLine[] {
  let fenced = false;
  return body
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((raw): ProtocolLine => {
      const fixed: ProtocolLine = { kind: "fixed", lead: "", text: raw, number: null };
      if (FENCE.test(raw)) {
        fenced = !fenced;
        return fixed;
      }
      if (fenced) return fixed;
      if (raw.trim() === "") return { kind: "blank", lead: "", text: "", number: null };
      if (raw.trimStart().startsWith("|")) return fixed;
      const heading = HEADING.exec(raw);
      if (heading !== null) return { kind: "heading", lead: heading[1] ?? "", text: heading[2] ?? "", number: null };
      const step = STEP.exec(raw);
      if (step !== null) return { kind: "step", lead: step[1] ?? "", text: step[3] ?? "", number: Number(step[2]) };
      const item = ITEM.exec(raw);
      if (item !== null) return { kind: "item", lead: item[1] ?? "", text: item[2] ?? "", number: null };
      const quote = QUOTE.exec(raw);
      if (quote !== null) return { kind: "text", lead: quote[1] ?? "", text: quote[2] ?? "", number: null };
      return { kind: "text", lead: "", text: raw, number: null };
    });
}

// Back to Markdown, each list's steps numbered 1, 2, 3 in the order they stand. An emptied
// line is left out.
export function writeLines(lines: readonly ProtocolLine[]): string {
  const counters = new Map<number, number>();
  const out: string[] = [];
  for (const line of lines) {
    if (line.kind === "step") {
      if (line.text.trim() === "") continue;
      const depth = line.lead.length;
      for (const d of counters.keys()) if (d > depth) counters.delete(d);
      const n = (counters.get(depth) ?? 0) + 1;
      counters.set(depth, n);
      out.push(`${line.lead}${n}. ${line.text.trim()}`);
      continue;
    }
    if (line.kind !== "blank" && !/^\s/.test(line.lead === "" ? line.text : line.lead)) counters.clear();
    if ((line.kind === "item" || line.kind === "text") && line.text.trim() === "") continue;
    out.push(line.kind === "fixed" || line.kind === "blank" ? line.text : `${line.lead}${line.kind === "heading" ? line.text : line.text.trim()}`);
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

// ---- What changed from the plan.

// Where a line of the plan stands: one of its numbered steps, or a line under a heading
// (null: above the first heading).
export type PlanPlace = { kind: "step"; number: number } | { kind: "section"; heading: string | null };

export type PlanChange =
  | { kind: "changed"; at: PlanPlace; was: string; now: string }
  | { kind: "left_out"; at: PlanPlace; text: string }
  | { kind: "added"; after: PlanPlace; lines: string[] };

export type PlanState =
  // No protocol and nothing written down.
  | { kind: "no_plan" }
  // What was done is written down, with no protocol to compare it with.
  | { kind: "unplanned"; asRun: string }
  // A protocol, and nobody has said what was actually done.
  | { kind: "missing" }
  | { kind: "as_written" }
  | { kind: "changed"; changes: PlanChange[] }
  // Too long a stretch differs to line the two up: both are shown whole.
  | { kind: "too_different"; plan: string; asRun: string };

type Keyed = { key: string; line: ProtocolLine; place: PlanPlace };

// The lines that carry words, each with a key to compare by (a step's number and runs of spaces
// left out, so taking out step 3 doesn't read as every later step changed) and its place.
function keyed(body: string): Keyed[] {
  let heading: string | null = null;
  const out: Keyed[] = [];
  for (const line of readLines(body)) {
    if (line.kind === "blank" || (line.kind === "fixed" && TABLE_RULE.test(line.text))) continue;
    // A line added just below a heading is under that heading.
    if (line.kind === "heading") heading = plainText(line.text);
    const place: PlanPlace = line.kind === "step" && line.number !== null ? { kind: "step", number: line.number } : { kind: "section", heading };
    out.push({ key: `${line.kind}\u0000${line.lead.trim()}\u0000${line.text.trim().replace(/\s+/g, " ")}`, line, place });
  }
  return out;
}

const shown = (line: ProtocolLine) => plainText(line.text);

// How a run of changed lines lines up: a line of the plan that became an added line, a line of
// the plan that went, or a line that's new.
type Step = { kind: "pair"; was: Keyed; now: Keyed } | { kind: "gone"; was: Keyed } | { kind: "new"; now: Keyed };

const wordsOf = (k: Keyed) => new Set(shown(k.line).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

// The share of words two lines have in common.
function likeness(a: Keyed, b: Keyed): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared === 0 ? 0 : shared / (x.size + y.size - shared);
}
const ALIKE = 0.3;

function inOrder(removed: readonly Keyed[], added: readonly Keyed[]): Step[] {
  const pairs = Math.min(removed.length, added.length);
  return [
    ...removed.slice(0, pairs).map((was, k): Step => ({ kind: "pair", was, now: added[k] ?? was })),
    ...removed.slice(pairs).map((was): Step => ({ kind: "gone", was })),
    ...added.slice(pairs).map((now): Step => ({ kind: "new", now })),
  ];
}

// Pairs each removed line with the added line it most likely became, keeping both in order,
// so a step edited beside a step added reads as one change and one addition. With nothing
// alike and as many lines back as went, they're paired in order: each was rewritten.
function align(removed: readonly Keyed[], added: readonly Keyed[]): Step[] {
  if (removed.length * added.length > 10_000) return inOrder(removed, added);
  const like = removed.map((r) => added.map((a) => likeness(r, a)));
  const best = Array.from({ length: removed.length + 1 }, () => new Array<number>(added.length + 1).fill(0));
  const at = (i: number, j: number) => best[i]?.[j] ?? 0;
  const paired = (i: number, j: number) => {
    const s = like[i]?.[j] ?? 0;
    return s >= ALIKE ? s + at(i + 1, j + 1) : -1;
  };
  for (let i = removed.length - 1; i >= 0; i -= 1) {
    const row = best[i];
    for (let j = added.length - 1; j >= 0; j -= 1) if (row !== undefined) row[j] = Math.max(at(i + 1, j), at(i, j + 1), paired(i, j));
  }
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < removed.length || j < added.length) {
    const was = removed[i];
    const now = added[j];
    if (was !== undefined && now !== undefined && paired(i, j) >= 0 && at(i, j) === paired(i, j)) {
      steps.push({ kind: "pair", was, now });
      i += 1;
      j += 1;
    } else if (was !== undefined && (now === undefined || at(i, j) === at(i + 1, j))) {
      steps.push({ kind: "gone", was });
      i += 1;
    } else if (now !== undefined) {
      steps.push({ kind: "new", now });
      j += 1;
    }
  }
  return steps.some((s) => s.kind === "pair") || removed.length !== added.length ? steps : inOrder(removed, added);
}

// The changes, in the plan's order.
export function planChanges(plan: string, asRun: string): PlanChange[] | null {
  const before = keyed(plan);
  const after = keyed(asRun);
  const diff = diffLines(before.map((k) => k.key).join("\n"), after.map((k) => k.key).join("\n"));
  if (diff === null) return null;
  const changes: PlanChange[] = [];
  let i = 0;
  let j = 0;
  let last: PlanPlace = { kind: "section", heading: null };
  let removed: Keyed[] = [];
  let added: Keyed[] = [];
  const flush = () => {
    let pending: string[] = [];
    const addPending = () => {
      if (pending.length > 0) changes.push({ kind: "added", after: last, lines: pending });
      pending = [];
    };
    for (const step of align(removed, added)) {
      if (step.kind === "new") {
        pending.push(shown(step.now.line));
        continue;
      }
      addPending();
      changes.push(
        step.kind === "pair"
          ? { kind: "changed", at: step.was.place, was: shown(step.was.line), now: shown(step.now.line) }
          : { kind: "left_out", at: step.was.place, text: shown(step.was.line) },
      );
      last = step.was.place;
    }
    addPending();
    removed = [];
    added = [];
  };
  for (const row of diff) {
    if (row.kind === "same") {
      flush();
      const kept = before[i];
      if (kept !== undefined) last = kept.place;
      i += 1;
      j += 1;
    } else if (row.kind === "removed") {
      const gone = before[i];
      if (gone !== undefined) removed.push(gone);
      i += 1;
    } else {
      const now = after[j];
      if (now !== undefined) added.push(now);
      j += 1;
    }
  }
  flush();
  return changes;
}

// The text the as-run is compared with: the version it started from, else the picked one.
export function comparedWith(plan: PlanFields, bodies: PlanBodies): string | null {
  if ((plan.asRun?.basedOn ?? null) !== null && bodies.basedOn !== null) return bodies.basedOn.body;
  return bodies.planned;
}

export function planState(plan: PlanFields, bodies: PlanBodies): PlanState {
  const base = comparedWith(plan, bodies);
  if (plan.asRun === null) return plan.planned === null ? { kind: "no_plan" } : { kind: "missing" };
  if (base === null) return { kind: "unplanned", asRun: plan.asRun.body };
  const changes = planChanges(base, plan.asRun.body);
  if (changes === null) return { kind: "too_different", plan: base, asRun: plan.asRun.body };
  return changes.length === 0 ? { kind: "as_written" } : { kind: "changed", changes };
}

// ---- Words.

const under = (heading: string | null, what: string, top: string) => (heading === null || heading === "" ? top : `${what} under “${heading}”`);

export function changeTitle(change: PlanChange): string {
  switch (change.kind) {
    case "changed":
      return change.at.kind === "step" ? `Step ${change.at.number} changed` : under(change.at.heading, "Changed", "Changed near the top");
    case "left_out":
      return change.at.kind === "step" ? `Step ${change.at.number} left out` : under(change.at.heading, "Left out", "Left out near the top");
    case "added":
      return change.after.kind === "step" ? `Added after step ${change.after.number}` : under(change.after.heading, "Added", "Added at the top");
  }
}

export function changesLine(count: number): string {
  return count === 1 ? "1 change from the protocol" : `${count} changes from the protocol`;
}
