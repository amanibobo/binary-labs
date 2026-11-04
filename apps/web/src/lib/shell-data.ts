import "server-only";
import type { FolderRow } from "./folders";
import { loadFolderTree, loadMembers, loadNeedsLookCount } from "./lab-data";
import type { Member } from "./viewer";

// Everything the sidebar shows, loaded once per page.
export type ShellData = { labName: string; memberCount: number; email: string; folders: FolderRow[]; needsLookCount: number };

export async function loadShell({ supabase, lab, user }: Member): Promise<ShellData> {
  const [members, folders, needsLookCount] = await Promise.all([
    loadMembers(supabase, lab.id),
    loadFolderTree(supabase, lab.id),
    loadNeedsLookCount(supabase, lab.id),
  ]);
  return { labName: lab.name, memberCount: members.length, email: user.email, folders, needsLookCount };
}
