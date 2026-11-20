import "server-only";
import { z } from "zod";
import { LabelOutcome } from "./domain";
import { CheckSpecs } from "./checks";
import { CheckId, FlagId, LocationId, ProtocolId, Sha256, type LabId } from "./ids";
import { historyOrder, RESULTS, type HistoryRun, type RunHistory } from "./run-history";
import type { RunChoices, RunInfo } from "./runs";
import { unwrap, type Supabase } from "./supabase/server";

// Files as runs (lib/runs.ts), read as the member under RLS: their names, days and outcomes
// from their labels, and the other data sheets of a file's experiment.

const CHOICES = 40;

const LocationRow = z.object({ id: LocationId, sha256: Sha256, original_name: z.string(), modified_at: z.string() });
const LabelRow = z.object({
  sha256: Sha256,
  clean_name: z.string().nullable(),
  date: z.string().nullable(),
  outcome: LabelOutcome.nullable(),
  experiment_id: z.string().nullable(),
});

export async function loadRuns(supabase: Supabase, labId: LabId, shas: readonly Sha256[]): Promise<RunInfo[]> {
  const wanted = [...new Set(shas)];
  if (wanted.length === 0) return [];
  const [locations, labels] = await Promise.all([
    supabase.from("file_locations").select("id, sha256, original_name, modified_at").eq("lab_id", labId).in("sha256", wanted).is("deleted_at", null).order("modified_at", { ascending: false }),
    supabase.from("labels").select("sha256, clean_name, date, outcome, experiment_id").eq("lab_id", labId).in("sha256", wanted),
  ]);
  const places = z.array(LocationRow).parse(unwrap(locations));
  const named = new Map(z.array(LabelRow).parse(unwrap(labels)).map((l) => [l.sha256, l]));
  const experimentIds = [...new Set([...named.values()].flatMap((l) => (l.experiment_id === null ? [] : [l.experiment_id])))];
  const experiments =
    experimentIds.length === 0
      ? new Map<string, string>()
      : new Map(z.array(z.object({ id: z.string(), name: z.string() })).parse(unwrap(await supabase.from("experiments").select("id, name").eq("lab_id", labId).in("id", experimentIds))).map((e) => [e.id, e.name]));
  const out = new Map<Sha256, RunInfo>();
  for (const p of places) {
    if (out.has(p.sha256)) continue;
    const label = named.get(p.sha256);
    out.set(p.sha256, {
      sha256: p.sha256,
      locationId: p.id,
      name: label?.clean_name ?? p.original_name,
      date: label?.date ?? p.modified_at.slice(0, 10),
      outcome: label?.outcome ?? null,
      experiment: label?.experiment_id == null ? null : (experiments.get(label.experiment_id) ?? null),
    });
  }
  return wanted.flatMap((sha) => {
    const run = out.get(sha);
    return run === undefined ? [] : [run];
  });
}

// The runs "Add runs" offers for a file: the other data sheets of its experiment, oldest first,
// then the lab's latest data sheets, each with a ready table.
export async function loadRunChoices(supabase: Supabase, labId: LabId, sha: Sha256): Promise<RunChoices> {
  const [own] = z.array(LabelRow).parse(unwrap(await supabase.from("labels").select("sha256, clean_name, date, outcome, experiment_id").eq("lab_id", labId).eq("sha256", sha).limit(1)));
  const experimentId = own?.experiment_id ?? null;
  const siblings =
    experimentId === null
      ? []
      : z.array(z.object({ sha256: Sha256 })).parse(unwrap(await supabase.from("labels").select("sha256").eq("lab_id", labId).eq("experiment_id", experimentId).neq("sha256", sha).limit(200))).map((r) => r.sha256);
  const recent = z
    .array(z.object({ sha256: Sha256 }))
    .parse(unwrap(await supabase.from("data_tables").select("sha256").eq("lab_id", labId).eq("state", "ready").neq("sha256", sha).order("updated_at", { ascending: false }).limit(CHOICES)))
    .map((r) => r.sha256);
  const ready =
    siblings.length === 0
      ? new Set<Sha256>()
      : new Set(z.array(z.object({ sha256: Sha256 })).parse(unwrap(await supabase.from("data_tables").select("sha256").eq("lab_id", labId).eq("state", "ready").in("sha256", siblings))).map((r) => r.sha256));
  const ordered = [...siblings.filter((s) => ready.has(s)), ...recent.filter((s) => !siblings.includes(s))].slice(0, CHOICES);
  const runs = await loadRuns(supabase, labId, ordered);
  const inExperiment = runs.filter((r) => ready.has(r.sha256)).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.name.localeCompare(b.name));
  const rest = runs.filter((r) => !ready.has(r.sha256));
  const experiment = experimentId === null ? null : (inExperiment[0]?.experiment ?? (await experimentName(supabase, labId, experimentId)));
  return { experiment, runs: [...inExperiment, ...rest] };
}

const ResultRow = z.object({
  sha256: Sha256,
  protocol_version_id: z.string(),
  outcome: z.enum(RESULTS),
  observed: z.number().nullable(),
  unit: z.string().nullable(),
  reason: z.string().nullable(),
});

// A check's results across the files it ran on, each with the range of the version it was
// checked against; null when the protocol isn't the lab's or none of its versions has the check.
export async function loadRunHistory(supabase: Supabase, labId: LabId, protocolId: ProtocolId, checkId: CheckId | null): Promise<RunHistory | null> {
  const [found] = z
    .array(z.object({ id: ProtocolId, current_version_id: z.string() }))
    .parse(unwrap(await supabase.from("protocols").select("id, current_version_id").eq("lab_id", labId).eq("id", protocolId).limit(1)));
  if (found === undefined) return null;
  const [head] = z
    .array(z.object({ title: z.string(), expected_values: CheckSpecs }))
    .parse(unwrap(await supabase.from("protocol_versions").select("title, expected_values").eq("id", found.current_version_id).limit(1)));
  if (head === undefined) return null;
  const protocol = { id: found.id, title: head.title };
  const current = head.expected_values;
  const id = checkId ?? current[0]?.id ?? null;
  if (id === null) return null;
  const results = z.array(ResultRow).parse(
    unwrap(await supabase.from("check_results").select("sha256, protocol_version_id, outcome, observed, unit, reason").eq("lab_id", labId).eq("protocol_id", protocolId).eq("check_id", id)),
  );
  const versionIds = [...new Set(results.map((r) => r.protocol_version_id))];
  const versions =
    versionIds.length === 0
      ? []
      : z
          .array(z.object({ id: z.string(), version: z.number().int().positive(), expected_values: CheckSpecs }))
          .parse(unwrap(await supabase.from("protocol_versions").select("id, version, expected_values").eq("protocol_id", protocolId).in("id", versionIds)));
  const byVersion = new Map(versions.map((v) => [v.id, { version: v.version, check: v.expected_values.find((c) => c.id === id) }]));
  const check = current.find((c) => c.id === id) ?? [...versions].sort((a, b) => b.version - a.version).flatMap((v) => v.expected_values.filter((c) => c.id === id))[0];
  if (check === undefined) return null;
  const [runs, flags] = await Promise.all([
    loadRuns(supabase, labId, results.map((r) => r.sha256)),
    z
      .array(z.object({ id: FlagId, sha256: Sha256 }))
      .parse(unwrap(await supabase.from("flags").select("id, sha256").eq("lab_id", labId).eq("protocol_id", protocolId).eq("check_id", id).is("cleared_at", null))),
  ]);
  const runOf = new Map(runs.map((r) => [r.sha256, r]));
  const flagOf = new Map(flags.map((f) => [f.sha256, f.id]));
  const history: HistoryRun[] = results.flatMap((r) => {
    const run = runOf.get(r.sha256);
    const held = byVersion.get(r.protocol_version_id);
    if (run === undefined || held?.check === undefined) return [];
    return [{ run, observed: r.observed, result: r.outcome, reason: r.reason, range: held.check.range, unit: r.unit ?? held.check.unit, version: held.version, flagId: flagOf.get(r.sha256) ?? null }];
  });
  return {
    protocol: { id: protocol.id, title: protocol.title },
    check,
    checks: (current.length > 0 ? current : [check]).map((c) => ({ id: c.id, name: c.name })),
    runs: history.sort(historyOrder),
  };
}

async function experimentName(supabase: Supabase, labId: LabId, id: string): Promise<string | null> {
  const [row] = z.array(z.object({ name: z.string() })).parse(unwrap(await supabase.from("experiments").select("name").eq("lab_id", labId).eq("id", id).limit(1)));
  return row?.name ?? null;
}
