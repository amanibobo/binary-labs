import "server-only";
import {
  DRIVE_PAGE_SIZE,
  DriveFolderRows,
  FileHistoryRows,
  parseDriveFiles,
  versionDetails,
  type DriveBy,
  type DriveFile,
  type DriveFolder,
  type DriveKey,
  type FileVersion,
  type VersionDetail,
  type VersionId,
} from "./drive";
import type { LabId, LocationId } from "./ids";
import { unwrap, type Supabase } from "./supabase/server";

export async function loadDriveFolders(supabase: Supabase, labId: LabId, by: DriveBy): Promise<DriveFolder[]> {
  return DriveFolderRows.parse(unwrap(await supabase.rpc("drive_folders", { p_lab_id: labId, p_by: by })));
}

export async function loadDriveFiles(supabase: Supabase, labId: LabId, by: DriveBy, key: DriveKey, offset: number): Promise<DriveFile[]> {
  return parseDriveFiles(
    unwrap(await supabase.rpc("drive_files", { p_lab_id: labId, p_by: by, p_key: key, p_limit: DRIVE_PAGE_SIZE, p_offset: offset })),
  );
}

// Oldest first; empty when the file isn't there, isn't this lab's, or was deleted.
export async function loadFileHistory(supabase: Supabase, labId: LabId, location: LocationId): Promise<FileVersion[]> {
  return FileHistoryRows.parse(unwrap(await supabase.rpc("file_history", { p_lab_id: labId, p_location_id: location })));
}

async function loadVersionText(supabase: Supabase, labId: LabId, version: VersionId): Promise<string | null> {
  const text = unwrap(await supabase.rpc("version_text", { p_lab_id: labId, p_version_id: version }));
  return typeof text === "string" ? text : null;
}

// Texts are read for the newest versions only; older ones say what changed by size.
export const COMPARED_VERSIONS = 12;

// Each version with what it changed from the one before it.
export async function loadVersionDetails(supabase: Supabase, labId: LabId, versions: readonly FileVersion[]): Promise<VersionDetail[]> {
  // The version before the first compared one is read too, as that one's "before".
  const firstRead = Math.max(0, versions.length - COMPARED_VERSIONS) - 1;
  const texts = await Promise.all(versions.map((v, i) => (i >= firstRead ? loadVersionText(supabase, labId, v.id) : null)));
  return versionDetails(versions, texts);
}
