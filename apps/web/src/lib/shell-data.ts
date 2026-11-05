import "server-only";
import type { FolderRow } from "./folders";
import { loadFolderTree, loadMembers, loadNeedsLookCount } from "./lab-data";
import type { Member } from "./viewer";

// Everything the sidebar shows, loaded once per page.
export type ShellData = {
  labName: string;
  memberCount: number;
  // The first few members, for the avatars on the sidebar's invite button.
  memberEmails: string[];
  isAdmin: boolean;
  email: string;
  folders: FolderRow[];
  needsLookCount: number;
};

export async function loadShell({ supabase, lab, user }: Member): Promise<ShellData> {
  const [members, folders, needsLookCount] = await Promise.all([
    loadMembers(supabase, lab.id),
    loadFolderTree(supabase, lab.id),
    loadNeedsLookCount(supabase, lab.id),
  ]);
  return {
    labName: lab.name,
    memberCount: members.length,
    memberEmails: members.flatMap((m) => (m.email === null ? [] : [m.email])).slice(0, 3),
    isAdmin: lab.role === "admin",
    email: user.email,
    folders,
    needsLookCount,
  };
}
