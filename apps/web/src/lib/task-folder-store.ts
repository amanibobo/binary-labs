import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { askExportGate } from "./export-gate";
import type { LabId, RunId, Sha256 } from "./ids";
import type { RunDb, Written } from "./run-record-store";
import { fromRow } from "./run-record";
import { unwrap } from "./supabase/server";
import {
  Exclusion,
  ExportReason,
  FOLDER_FORMAT,
  RunTaskJson,
  snakeKeys,
  TaskManifestJson,
  TaskSourceJson,
  type RunTask,
  type SaveTaskRequest,
  type TaskManifest,
  type TaskPreview,
  type TaskSource,
} from "./task-export";
import { buildTaskFolder, planEvidence, previewOf, type TaskFolder } from "./task-folder";
import { writeZip, type ZipEntry } from "./task-folder-zip";
import { uploadKey } from "./uploads";

// The task folder's reads and writes. Building goes: ask the gate, read the run, de-identify
// it, write a zip and its manifest under <lab>/exports/<id>/, then record it with
// build_task_export, where the database has the last word. A refusal there removes what was
// written.

// What this file asks of the store: lib/object-store.ts in the app, a folder in tests.
export type FolderStore = {
  read: (key: string) => Promise<AsyncIterable<Uint8Array>>;
  put: (key: string, file: { path: string; size: number }, contentType: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};
export type FolderDeps = { db: RunDb; store: FolderStore };

const exportPrefix = (labId: LabId, exportId: string) => `${labId}/exports/${exportId}`;
const zipKey = (prefix: string) => `${prefix}/task.zip`;
const manifestKey = (prefix: string) => `${prefix}/manifest.json`;

const reasonsOf = (raw: readonly string[]): ExportReason[] => [...new Set(raw.map((r) => ExportReason.catch("no_grant").parse(r)))];

export async function loadRunTask(db: RunDb, runId: RunId): Promise<RunTask | null> {
  const json = unwrap(await db.rpc("run_task_json", { p_run_id: runId }));
  return json === null ? null : RunTaskJson.parse(json);
}

export async function saveRunTask(db: RunDb, runId: RunId, task: SaveTaskRequest): Promise<Written<RunTask>> {
  const { data, error } = await db.rpc("save_run_task", {
    p_run_id: runId,
    p_question: task.question,
    p_rubric: task.rubric,
    p_reviewer_id: task.reviewerId,
    p_notes: task.notes,
    p_agrees: task.agrees,
  });
  return error !== null ? { kind: "error", error } : { kind: "ok", value: RunTaskJson.parse(data) };
}

export async function setExclusion(db: RunDb, labId: LabId, x: { kind: string; value: string; on: boolean }): Promise<Written<Exclusion[]>> {
  const { data, error } = await db.rpc("set_export_exclusion", { p_lab_id: labId, p_kind: x.kind, p_value: x.value, p_on: x.on });
  return error !== null ? { kind: "error", error } : { kind: "ok", value: z.array(Exclusion).parse(data) };
}

async function bytesOf(store: FolderStore, key: string): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of await store.read(key)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// The run's source and its folder, de-identified. Only the text files' bytes are read here.
async function assemble(db: RunDb, store: FolderStore, labId: LabId, runId: RunId): Promise<Written<{ source: TaskSource; folder: TaskFolder }>> {
  const { data, error } = await db.rpc("task_export_source", { p_run_id: runId });
  if (error !== null) return { kind: "error", error };
  const source = TaskSourceJson.parse(data);
  const text = new Map<Sha256, Uint8Array>();
  for (const plan of planEvidence(source)) {
    if (plan.leftOut === null && plan.text) text.set(plan.file.sha256, await bytesOf(store, uploadKey(labId, plan.file.sha256)));
  }
  return { kind: "ok", value: { source, folder: buildTaskFolder(source, text) } };
}

export async function previewTask(db: RunDb, store: FolderStore, labId: LabId, runId: RunId): Promise<Written<TaskPreview>> {
  const made = await assemble(db, store, labId, runId);
  return made.kind === "error" ? made : { kind: "ok", value: previewOf(made.value.source, made.value.folder) };
}

const Recorded = fromRow(
  z.discriminatedUnion("kind", [z.object({ kind: z.literal("built"), id: z.uuid(), prefix: z.string() }), z.object({ kind: z.literal("blocked"), reasons: z.array(z.string()) })]),
);

export type Built = { kind: "built"; id: string } | { kind: "blocked"; reasons: ExportReason[] } | { kind: "leaks"; paths: string[] } | { kind: "no_run" };

// Records the attempt with the database, which refuses and logs it unless the run may leave.
async function record(db: RunDb, runId: RunId, exportId: string, grantId: number | null, manifest: unknown): Promise<Written<z.infer<typeof Recorded>>> {
  const { data, error } = await db.rpc("build_task_export", { p_run_id: runId, p_export_id: exportId, p_grant_id: grantId, p_purpose: "task_folder", p_manifest: manifest });
  return error !== null ? { kind: "error", error } : { kind: "ok", value: Recorded.parse(data) };
}

export async function buildTask({ db, store }: FolderDeps, labId: LabId, runId: RunId): Promise<Written<Built>> {
  const exportId = randomUUID();
  // The gate logs its own answer, yes or no.
  const gate = await askExportGate(db, runId, "task folder");
  if (gate.kind === "blocked") return { kind: "ok", value: gate.blocks.includes("no_such_run") ? { kind: "no_run" } : { kind: "blocked", reasons: reasonsOf(gate.blocks) } };

  const made = await assemble(db, store, labId, runId);
  if (made.kind === "error") return made;
  const { source, folder } = made.value;
  if (source.gaps.length > 0) {
    // Consent is given but the task isn't whole. The database writes the refusal down.
    const refused = await record(db, runId, exportId, gate.grantId, {});
    if (refused.kind === "error") return refused;
    return { kind: "ok", value: { kind: "blocked", reasons: reasonsOf(refused.value.kind === "blocked" ? refused.value.reasons : source.gaps) } };
  }
  if (folder.leaks.length > 0) return { kind: "ok", value: { kind: "leaks", paths: folder.leaks } };

  const builtAt = new Date();
  const encode = (text: string) => new TextEncoder().encode(text);
  const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const parts = folder.parts.map((p) => ({ path: p.path, data: encode(p.text) }));
  const evidence = folder.evidence.map((e) => {
    const data = e.text === null ? null : encode(e.text);
    return { ...e, data, bytes: data?.length ?? e.size, sha256: data === null ? e.sourceSha256 : hashOf(data) };
  });
  const manifest: TaskManifest = {
    format: FOLDER_FORMAT,
    taskId: exportId,
    runId,
    builtAt: builtAt.toISOString(),
    sample: source.lab.demo,
    taxonomyVersion: source.run.taxonomyVersion,
    parts: parts.map((p) => ({ path: p.path, bytes: p.data.length, sha256: hashOf(p.data) })),
    evidence: evidence.map((e) => ({ path: e.path, role: e.role, kind: e.kind, treatment: e.treatment, bytes: e.bytes, sha256: e.sha256, sourceSha256: e.sourceSha256 })),
    leftOut: folder.leftOut.map(({ kind, role, reason }) => ({ kind, role, reason })),
    deidentification: { ...folder.counts, excluded: folder.excluded, includedAsIs: evidence.filter((e) => e.treatment === "as_is").map((e) => e.path) },
  };
  const root = `task-${exportId}`;
  const entries: ZipEntry[] = [
    { path: `${root}/manifest.json`, data: encode(`${JSON.stringify(snakeKeys(manifest), null, 2)}\n`) },
    ...parts.map((p) => ({ path: `${root}/${p.path}`, data: p.data })),
    ...evidence.map((e) => ({ path: `${root}/${e.path}`, data: e.data ?? (() => store.read(uploadKey(labId, e.sourceSha256))) })),
  ];

  const prefix = exportPrefix(labId, exportId);
  const dir = await mkdtemp(join(tmpdir(), "binary-task-"));
  try {
    const zipPath = join(dir, "task.zip");
    const zip = await writeZip(zipPath, entries, builtAt);
    // A file copied from the store has to be the file the run names, or nothing is built.
    const changed = evidence.find((e) => e.data === null && zip.entries.find((z) => z.path === `${root}/${e.path}`)?.sha256 !== e.sourceSha256);
    if (changed !== undefined) throw new Error(`a stored file doesn't match what Binary read: ${changed.sourceSha256}`);
    const kept = snakeKeys({ ...manifest, zip: { bytes: zip.bytes, sha256: zip.sha256 } } satisfies TaskManifest);
    const manifestPath = join(dir, "manifest.json");
    const manifestBytes = encode(`${JSON.stringify(kept, null, 2)}\n`);
    await writeFile(manifestPath, manifestBytes);
    await store.put(zipKey(prefix), { path: zipPath, size: zip.bytes }, "application/zip");
    await store.put(manifestKey(prefix), { path: manifestPath, size: manifestBytes.length }, "application/json");

    const recorded = await record(db, runId, exportId, gate.grantId, kept);
    if (recorded.kind === "ok" && recorded.value.kind === "built") return { kind: "ok", value: { kind: "built", id: exportId } };
    await removeFolder(store, prefix);
    return recorded.kind === "error" ? recorded : { kind: "ok", value: { kind: "blocked", reasons: reasonsOf(recorded.value.kind === "blocked" ? recorded.value.reasons : []) } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function removeFolder(store: FolderStore, prefix: string): Promise<void> {
  await store.remove(zipKey(prefix));
  await store.remove(manifestKey(prefix));
}

const FolderRows = z.array(z.object({ lab_id: z.string(), storage_prefix: z.string().nullable(), withdrawn_at: z.string().nullable(), manifest: z.unknown() }));

// A folder built from a run whose sharing has since gone off is never handed out again;
// this takes its files out of the store too. Safe to run twice.
export async function removeWithdrawn(db: RunDb, store: FolderStore, task: RunTask): Promise<RunTask> {
  const stale = task.exports.filter((e) => e.withdrawnAt !== null && e.hasFiles);
  for (const folder of stale) {
    const [row] = FolderRows.parse(unwrap(await db.rpc("task_export_file", { p_run_id: task.runId, p_export_id: folder.id })));
    if (row?.storage_prefix != null) await removeFolder(store, row.storage_prefix);
    unwrap(await db.rpc("forget_task_export_files", { p_run_id: task.runId, p_export_id: folder.id }));
  }
  return stale.length === 0 ? task : { ...task, exports: task.exports.map((e) => (e.withdrawnAt === null ? e : { ...e, hasFiles: false })) };
}

export type Opened =
  | { kind: "ok"; bytes: number; name: string; body: AsyncIterable<Uint8Array> }
  | { kind: "blocked"; reasons: ExportReason[] }
  | { kind: "withdrawn" }
  | { kind: "missing" }
  | { kind: "mismatch" };

// Hands over a built folder's zip. The gate is asked again, a withdrawn folder is refused,
// and the stored bytes are checked against the manifest before any of them is sent.
export async function openTask({ db, store }: FolderDeps, runId: RunId, exportId: string): Promise<Opened> {
  const gate = await askExportGate(db, runId, "task folder download");
  if (gate.kind === "blocked") return gate.blocks.includes("no_such_run") ? { kind: "missing" } : { kind: "blocked", reasons: reasonsOf(gate.blocks) };
  const [row] = FolderRows.parse(unwrap(await db.rpc("task_export_file", { p_run_id: runId, p_export_id: exportId })));
  if (row === undefined) return { kind: "missing" };
  if (row.withdrawn_at !== null || row.storage_prefix === null) return { kind: "withdrawn" };
  const zip = TaskManifestJson.parse(row.manifest).zip;
  if (zip === undefined) return { kind: "missing" };
  const hash = createHash("sha256");
  try {
    for await (const chunk of await store.read(zipKey(row.storage_prefix))) hash.update(chunk);
  } catch {
    return { kind: "missing" };
  }
  if (hash.digest("hex") !== zip.sha256) return { kind: "mismatch" };
  return { kind: "ok", bytes: zip.bytes, name: `task-${exportId}.zip`, body: await store.read(zipKey(row.storage_prefix)) };
}
