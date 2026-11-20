import "server-only";
import { z } from "zod";
import { CheckSpecs } from "./checks";
import { ProtocolId, Sha256, type CheckId, type LabId } from "./ids";
import { assembleHistory, HISTORY_RESULT_COLUMNS, OpenFlagRows, ResultRows, VersionRows, type RunHistory } from "./run-history";
import { assembleRuns, ExperimentRows, LABEL_RUN_COLUMNS, LabelRunRows, LOCATION_RUN_COLUMNS, LocationRunRows, type RunChoices, type RunInfo } from "./runs";
import { unwrap, type Supabase } from "./supabase/server";

// Files as runs (lib/runs.ts) and a check's run history (lib/run-history.ts), read as the
// member under RLS. The assembly is pure and lives beside the types; this file only reads.

const CHOICES = 40;

export async function loadRuns(supabase: Supabase, labId: LabId, shas: readonly Sha256[]): Promise<RunInfo[]> {
  const wanted = [...new Set(shas)];
  if (wanted.length === 0) return [];
  const [locations, labels] = await Promise.all([
    supabase.from("file_locations").select(LOCATION_RUN_COLUMNS).eq("lab_id", labId).in("sha256", wanted).is("deleted_at", null).order("modified_at", { ascending: false }),
    supabase.from("labels").select(LABEL_RUN_COLUMNS).eq("lab_id", labId).in("sha256", wanted),
  ]);
  const named = LabelRunRows.parse(unwrap(labels));
  const experimentIds = [...new Set(named.flatMap((l) => (l.experiment_id === null ? [] : [l.experiment_id])))];
  const experiments = experimentIds.length === 0 ? [] : ExperimentRows.parse(unwrap(await supabase.from("experiments").select("id, name").eq("lab_id", labId).in("id", experimentIds)));
  return assembleRuns(wanted, LocationRunRows.parse(unwrap(locations)), named, experiments);
}

// The runs "Add runs" offers for a file: the other data sheets of its experiment, oldest first,
// then the lab's latest data sheets, each with a ready table.
export async function loadRunChoices(supabase: Supabase, labId: LabId, sha: Sha256): Promise<RunChoices> {
  const [own] = LabelRunRows.parse(unwrap(await supabase.from("labels").select(LABEL_RUN_COLUMNS).eq("lab_id", labId).eq("sha256", sha).limit(1)));
  const experimentId = own?.experiment_id ?? null;
  const shaRows = z.array(z.object({ sha256: Sha256 }));
  const siblings =
    experimentId === null ? [] : shaRows.parse(unwrap(await supabase.from("labels").select("sha256").eq("lab_id", labId).eq("experiment_id", experimentId).neq("sha256", sha).limit(200))).map((r) => r.sha256);
  const recent = shaRows
    .parse(unwrap(await supabase.from("data_tables").select("sha256").eq("lab_id", labId).eq("state", "ready").neq("sha256", sha).order("updated_at", { ascending: false }).limit(CHOICES)))
    .map((r) => r.sha256);
  const ready =
    siblings.length === 0 ? new Set<Sha256>() : new Set(shaRows.parse(unwrap(await supabase.from("data_tables").select("sha256").eq("lab_id", labId).eq("state", "ready").in("sha256", siblings))).map((r) => r.sha256));
  const ordered = [...siblings.filter((s) => ready.has(s)), ...recent.filter((s) => !siblings.includes(s))].slice(0, CHOICES);
  const runs = await loadRuns(supabase, labId, ordered);
  const inExperiment = runs.filter((r) => ready.has(r.sha256)).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.name.localeCompare(b.name));
  const rest = runs.filter((r) => !ready.has(r.sha256));
  const experiment = experimentId === null ? null : (inExperiment[0]?.experiment ?? (await experimentName(supabase, labId, experimentId)));
  return { experiment, runs: [...inExperiment, ...rest] };
}

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
  const id = checkId ?? head.expected_values[0]?.id ?? null;
  if (id === null) return null;
  const results = ResultRows.parse(unwrap(await supabase.from("check_results").select(HISTORY_RESULT_COLUMNS).eq("lab_id", labId).eq("protocol_id", protocolId).eq("check_id", id)));
  const versionIds = [...new Set(results.map((r) => r.protocol_version_id))];
  const [versions, runs, flags] = await Promise.all([
    versionIds.length === 0 ? [] : supabase.from("protocol_versions").select("id, version, expected_values").eq("protocol_id", protocolId).in("id", versionIds).then((r) => VersionRows.parse(unwrap(r))),
    loadRuns(supabase, labId, results.map((r) => r.sha256)),
    supabase.from("flags").select("id, sha256").eq("lab_id", labId).eq("protocol_id", protocolId).eq("check_id", id).is("cleared_at", null).then((r) => OpenFlagRows.parse(unwrap(r))),
  ]);
  return assembleHistory({ protocol: { id: found.id, title: head.title }, current: head.expected_values, checkId: id, results, versions, runs, flags });
}

async function experimentName(supabase: Supabase, labId: LabId, id: string): Promise<string | null> {
  const [row] = ExperimentRows.parse(unwrap(await supabase.from("experiments").select("id, name").eq("lab_id", labId).eq("id", id).limit(1)));
  return row?.name ?? null;
}
