import "server-only";
import type { FolderRow } from "./folders";
import { loadFolderTree, loadMembers, loadNeedsLookCount } from "./lab-data";
import type { OnboardingData } from "./onboarding";
import { loadOnboarding } from "./onboarding-data";
import type { Member } from "./viewer";

// Everything the sidebar shows, loaded once per page.
export type ShellData = {
  labName: string;
  memberCount: number;
  isAdmin: boolean;
  email: string;
  folders: FolderRow[];
  needsLookCount: number;
  onboarding: OnboardingData;
};

export async function loadShell(member: Member): Promise<ShellData> {
  const { supabase, lab, user } = member;
  const [members, folders, needsLookCount, onboarding] = await Promise.all([
    loadMembers(supabase, lab.id),
    loadFolderTree(supabase, lab.id),
    loadNeedsLookCount(supabase, lab.id),
    loadOnboarding(member),
  ]);
  return {
    labName: lab.name,
    memberCount: members.length,
    isAdmin: lab.role === "admin",
    email: user.email,
    folders,
    needsLookCount,
    onboarding,
  };
}
