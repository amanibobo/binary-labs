import "server-only";
import { z } from "zod";
import { LabelOutcome } from "./domain";
import { LocationId, Sha256, type LabId } from "./ids";
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

async function experimentName(supabase: Supabase, labId: LabId, id: string): Promise<string | null> {
  const [row] = z.array(z.object({ name: z.string() })).parse(unwrap(await supabase.from("experiments").select("name").eq("lab_id", labId).eq("id", id).limit(1)));
  return row?.name ?? null;
}
