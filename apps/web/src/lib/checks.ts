import { z } from "zod";
import { CheckId, ProtocolVersionId } from "./ids";
import { NOTE_MAX, protocolFailure, type ProtocolFailure } from "./protocols";

// A protocol's expected values (decisions.md, "checking results: expected values and flags").
// Mirrors check_spec_ok in db/migrations/0018_checks.sql and the worker's bl_worker/checks.py.
// Every key is present, with null meaning "work it out" or "none".

export const CHECK_KINDS = ["curve_fit", "peak", "value", "control"] as const;
export const CheckKind = z.enum(CHECK_KINDS);
export type CheckKind = z.infer<typeof CheckKind>;

export const RANGE_KINDS = ["at_least", "at_most", "between", "around"] as const;
export type RangeKind = (typeof RANGE_KINDS)[number];

const Bound = z.number().finite().gt(-1e15).lt(1e15);

export const CheckRange = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("at_least"), min: Bound }),
  z.strictObject({ kind: z.literal("at_most"), max: Bound }),
  z.strictObject({ kind: z.literal("between"), min: Bound, max: Bound }).refine((r) => r.min <= r.max, {
    message: "The lower end goes first.",
  }),
  z.strictObject({ kind: z.literal("around"), target: Bound, tolerance: Bound.nonnegative() }),
]);
export type CheckRange = z.infer<typeof CheckRange>;

const ColumnRef = z.string().trim().min(1).max(120);
const Optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((s) => (s === null || s === "" ? null : s));

const common = {
  id: CheckId,
  name: z.string().trim().min(1, "Give the check a name.").max(80, "Keep the name under 80 characters."),
  sheet: Optional(200),
  unit: Optional(40),
  range: CheckRange,
};

export const STATS = ["mean", "max", "min", "cell"] as const;
export type Stat = (typeof STATS)[number];

export const CheckSpec = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("curve_fit"), x: ColumnRef.nullable(), y: ColumnRef.nullable() }),
  z.strictObject({ ...common, kind: z.literal("peak"), x: ColumnRef.nullable(), y: ColumnRef.nullable() }),
  z
    .strictObject({ ...common, kind: z.literal("value"), column: ColumnRef, stat: z.enum(STATS), row: Optional(120) })
    .refine((c) => (c.stat === "cell") === (c.row !== null), { message: "A single cell names its row.", path: ["row"] }),
  z.strictObject({
    ...common,
    kind: z.literal("control"),
    pattern: z.string().trim().min(1, "Say what the control rows are called.").max(80),
    labelColumn: ColumnRef.nullable(),
    column: ColumnRef,
    use: z.enum(["each", "mean"]),
  }),
]);
export type CheckSpec = z.infer<typeof CheckSpec>;

export const MAX_CHECKS = 40;

export const CheckSpecs = z
  .array(CheckSpec)
  .max(MAX_CHECKS, `A protocol holds up to ${MAX_CHECKS} checks.`)
  .refine((checks) => new Set(checks.map((c) => c.id)).size === checks.length, { message: "Each check needs its own id." });

// POST /api/protocols/<id>/checks: the whole list, on top of the version the editor started from.
export const SaveChecksRequest = z.object({
  baseVersionId: ProtocolVersionId,
  checks: CheckSpecs,
  note: z
    .string()
    .trim()
    .max(NOTE_MAX, `Keep the note under ${NOTE_MAX} characters.`)
    .transform((s) => (s === "" ? null : s))
    .nullable(),
});
export type SaveChecksRequest = z.input<typeof SaveChecksRequest>;

export function saveChecksArgs(protocolId: string, req: z.output<typeof SaveChecksRequest>) {
  return { p_protocol_id: protocolId, p_base_version_id: req.baseVersionId, p_checks: req.checks, p_note: req.note };
}

// save_checks raises the protocol codes, BL108 for a tutorial, and 23514 for checks the
// database won't hold (the request schema should have caught those first).
export function checksFailure(error: { code?: string; message: string }): ProtocolFailure {
  switch (error.code) {
    case "BL108":
      return { kind: "error", status: 400, message: "A tutorial doesn't carry checks." };
    case "23514":
      return { kind: "error", status: 400, message: "One of the checks isn't complete. Look it over and save again." };
    default:
      return protocolFailure(error);
  }
}

// What a version's expected_values column holds; a row that doesn't parse would be our bug.
export const ExpectedValuesRows = z
  .array(z.object({ expected_values: CheckSpecs }))
  .max(1)
  .transform((rows) => rows[0]?.expected_values ?? []);

// Words ---------------------------------------------------------------------------------------

export const KIND_NAMES = {
  curve_fit: "Standard curve fit",
  peak: "Peak position",
  value: "A value in range",
  control: "Controls in range",
} satisfies Record<CheckKind, string>;

export const KIND_HELP = {
  curve_fit: "R² of a straight line through the standards, such as a Bradford or BCA curve.",
  peak: "Where the highest reading sits, such as an absorbance maximum or an elution volume.",
  value: "The mean, highest or lowest of a column, or one cell such as an A260/A280 ratio.",
  control: "The day's blanks or controls, found by their name, must read within the range.",
} satisfies Record<CheckKind, string>;

const number = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 });

export function formatNumber(v: number): string {
  return number.format(v);
}

function withUnit(text: string, unit: string | null): string {
  return unit === null ? text : `${text} ${unit}`;
}

// "at least 0.98", "280 ± 2 nm", "0.1 to 1 AU".
export function rangeText(range: CheckRange, unit: string | null): string {
  switch (range.kind) {
    case "at_least":
      return withUnit(`at least ${formatNumber(range.min)}`, unit);
    case "at_most":
      return withUnit(`at most ${formatNumber(range.max)}`, unit);
    case "between":
      return withUnit(`${formatNumber(range.min)} to ${formatNumber(range.max)}`, unit);
    case "around":
      return withUnit(`${formatNumber(range.target)} ± ${formatNumber(range.tolerance)}`, unit);
    default: {
      const _exhaustive: never = range;
      return _exhaustive;
    }
  }
}

export function valueText(v: number, unit: string | null): string {
  return withUnit(formatNumber(v), unit);
}

export function holds(range: CheckRange, v: number): boolean {
  switch (range.kind) {
    case "at_least":
      return v >= range.min;
    case "at_most":
      return v <= range.max;
    case "between":
      return v >= range.min && v <= range.max;
    case "around":
      return Math.abs(v - range.target) <= range.tolerance;
    default: {
      const _exhaustive: never = range;
      return _exhaustive;
    }
  }
}

const quoted = (s: string) => `“${s}”`;

// What a check computes, in one plain line.
export function measureText(check: CheckSpec): string {
  switch (check.kind) {
    case "curve_fit":
      return check.x === null && check.y === null
        ? "R² of the standard curve"
        : `R² of ${check.y === null ? "the signal" : quoted(check.y)} against ${check.x === null ? "concentration" : quoted(check.x)}`;
    case "peak":
      return check.x === null && check.y === null
        ? "Where the highest reading sits"
        : `Where ${check.y === null ? "the signal" : quoted(check.y)} is highest along ${check.x === null ? "its axis" : quoted(check.x)}`;
    case "value":
      switch (check.stat) {
        case "mean":
          return `Mean of ${quoted(check.column)}`;
        case "max":
          return `Highest ${quoted(check.column)}`;
        case "min":
          return `Lowest ${quoted(check.column)}`;
        case "cell":
          return `${quoted(check.column)} in row ${quoted(check.row ?? "")}`;
        default: {
          const _exhaustive: never = check.stat;
          return _exhaustive;
        }
      }
    case "control":
      return `${check.use === "each" ? "Every" : "The mean of the"} ${quoted(check.pattern)} ${check.use === "each" ? "row" : "rows"} in ${quoted(check.column)}`;
    default: {
      const _exhaustive: never = check;
      return _exhaustive;
    }
  }
}

export function ruleText(check: CheckSpec): string {
  return `${measureText(check)}: ${rangeText(check.range, check.unit)}`;
}

// The editor -------------------------------------------------------------------------------

// What the editor holds while someone types: every field as text, so switching a check's kind
// or range keeps what was typed. parseDraft turns it into a CheckSpec or says what's wrong.
export type CheckDraft = {
  id: CheckId;
  kind: CheckKind;
  name: string;
  sheet: string;
  unit: string;
  range: { kind: RangeKind; a: string; b: string };
  x: string;
  y: string;
  column: string;
  stat: Stat;
  row: string;
  pattern: string;
  labelColumn: string;
  use: "each" | "mean";
};

export type DraftField = "name" | "range" | "column" | "row" | "pattern" | "sheet" | "unit" | "x" | "y" | "labelColumn";

export const RANGE_NAMES = {
  at_least: "At least",
  at_most: "At most",
  between: "Between",
  around: "Around",
} satisfies Record<RangeKind, string>;

const DEFAULTS: Record<CheckKind, Pick<CheckDraft, "name" | "unit" | "range">> = {
  curve_fit: { name: "Standard curve fit", unit: "", range: { kind: "at_least", a: "0.98", b: "" } },
  peak: { name: "Absorbance maximum", unit: "nm", range: { kind: "around", a: "280", b: "2" } },
  value: { name: "", unit: "", range: { kind: "between", a: "", b: "" } },
  control: { name: "Blanks", unit: "", range: { kind: "at_most", a: "0.1", b: "" } },
};

export function newDraft(kind: CheckKind, id: CheckId): CheckDraft {
  return {
    id,
    kind,
    sheet: "",
    x: "",
    y: "",
    column: "",
    stat: "mean",
    row: "",
    pattern: kind === "control" ? "blank" : "",
    labelColumn: "",
    use: "each",
    ...DEFAULTS[kind],
  };
}

function rangeDraft(range: CheckRange): CheckDraft["range"] {
  switch (range.kind) {
    case "at_least":
      return { kind: range.kind, a: String(range.min), b: "" };
    case "at_most":
      return { kind: range.kind, a: String(range.max), b: "" };
    case "between":
      return { kind: range.kind, a: String(range.min), b: String(range.max) };
    case "around":
      return { kind: range.kind, a: String(range.target), b: String(range.tolerance) };
    default: {
      const _exhaustive: never = range;
      return _exhaustive;
    }
  }
}

export function toDraft(check: CheckSpec): CheckDraft {
  const base = { ...newDraft(check.kind, check.id), name: check.name, sheet: check.sheet ?? "", unit: check.unit ?? "", range: rangeDraft(check.range) };
  switch (check.kind) {
    case "curve_fit":
    case "peak":
      return { ...base, x: check.x ?? "", y: check.y ?? "" };
    case "value":
      return { ...base, column: check.column, stat: check.stat, row: check.row ?? "" };
    case "control":
      return { ...base, pattern: check.pattern, labelColumn: check.labelColumn ?? "", column: check.column, use: check.use };
    default: {
      const _exhaustive: never = check;
      return _exhaustive;
    }
  }
}

// Numbers as people type them: "0.98", "1,000", "1e-3", " 280 ".
export function readNumber(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (t === "" || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function draftRange(r: CheckDraft["range"]): CheckRange | string {
  const a = readNumber(r.a);
  const b = readNumber(r.b);
  switch (r.kind) {
    case "at_least":
      return a === null ? "Type the lowest value allowed." : { kind: r.kind, min: a };
    case "at_most":
      return a === null ? "Type the highest value allowed." : { kind: r.kind, max: a };
    case "between":
      if (a === null || b === null) return "Type both ends of the range.";
      return a <= b ? { kind: r.kind, min: a, max: b } : "The lower end goes first.";
    case "around":
      if (a === null || b === null) return "Type the value and how far it may be off.";
      return b >= 0 ? { kind: r.kind, target: a, tolerance: b } : "How far it may be off can't be negative.";
    default: {
      const _exhaustive: never = r.kind;
      return _exhaustive;
    }
  }
}

const orNull = (s: string) => (s.trim() === "" ? null : s.trim());

export type DraftOutcome = { kind: "ok"; check: CheckSpec } | { kind: "invalid"; field: DraftField; message: string };

export function parseDraft(d: CheckDraft): DraftOutcome {
  const range = draftRange(d.range);
  if (typeof range === "string") return { kind: "invalid", field: "range", message: range };
  const base = { id: d.id, name: d.name, sheet: orNull(d.sheet), unit: orNull(d.unit), range };
  const raw = (() => {
    switch (d.kind) {
      case "curve_fit":
      case "peak":
        return { ...base, kind: d.kind, x: orNull(d.x), y: orNull(d.y) };
      case "value":
        return { ...base, kind: d.kind, column: d.column, stat: d.stat, row: d.stat === "cell" ? orNull(d.row) : null };
      case "control":
        return { ...base, kind: d.kind, pattern: d.pattern, labelColumn: orNull(d.labelColumn), column: d.column, use: d.use };
      default: {
        const _exhaustive: never = d.kind;
        return _exhaustive;
      }
    }
  })();
  const parsed = CheckSpec.safeParse(raw);
  if (parsed.success) return { kind: "ok", check: parsed.data };
  const issue = parsed.error.issues[0];
  const field = DraftFieldName.safeParse(issue?.path[0]);
  return {
    kind: "invalid",
    field: field.success ? field.data : "name",
    message: messageFor(field.success ? field.data : "name", issue?.message),
  };
}

const DraftFieldName = z.enum(["name", "range", "column", "row", "pattern", "sheet", "unit", "x", "y", "labelColumn"]);

function messageFor(field: DraftField, fallback: string | undefined): string {
  switch (field) {
    case "column":
      return "Name the column to read.";
    case "row":
      return "Name the row, by the text in it or its number.";
    case "pattern":
      return "Say what the control rows are called, such as blank.";
    case "name":
      return fallback?.startsWith("Give") || fallback?.startsWith("Keep") ? fallback : "Give the check a name.";
    default:
      return fallback ?? "Check this field.";
  }
}

// A per-check answer rate for admins: how many of its flags people found useful.
export type Usefulness = { flags: number; useful: number; wrong: number; knownIssue: number };

export function usefulText(u: Usefulness): string {
  const answered = u.useful + u.wrong + u.knownIssue;
  if (u.flags === 0) return "No flags yet";
  if (answered === 0) return u.flags === 1 ? "1 flag, not answered yet" : `${u.flags} flags, none answered yet`;
  const pct = Math.round((100 * u.useful) / answered);
  return `${pct}% useful · ${u.useful} useful, ${u.wrong} wrong, ${u.knownIssue} known ${u.knownIssue === 1 ? "issue" : "issues"}`;
}
