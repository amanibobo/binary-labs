import "server-only";
import type { FolderRow } from "./folders";
import { loadFlagQueueCount } from "./flag-store";
import { loadFolderTree, loadMembers, loadNeedsLookCount } from "./lab-data";
import type { OnboardingData } from "./onboarding";
import { loadOnboarding } from "./onboarding-data";
import type { Member } from "./viewer";

// Everything the sidebar shows, loaded once per page.
export type ShellData = {
  labName: string;
  demo: boolean;
  memberCount: number;
  // Members' emails, oldest first, for the invite row's faces.
  memberEmails: string[];
  isAdmin: boolean;
  email: string;
  folders: FolderRow[];
  needsLookCount: number;
  // Open flags nobody has answered yet.
  flagCount: number;
  onboarding: OnboardingData;
};

export async function loadShell(member: Member): Promise<ShellData> {
  const { supabase, lab, user } = member;
  const [members, folders, needsLookCount, flagCount, onboarding] = await Promise.all([
    loadMembers(supabase, lab.id),
    loadFolderTree(supabase, lab.id),
    loadNeedsLookCount(supabase, lab.id),
    loadFlagQueueCount(supabase, lab.id),
    loadOnboarding(member),
  ]);
  return {
    labName: lab.name,
    demo: lab.demo,
    memberCount: members.length,
    memberEmails: members.flatMap((m) => (m.email === null ? [] : [m.email])),
    isAdmin: lab.role === "admin",
    email: user.email,
    folders,
    needsLookCount,
    flagCount,
    onboarding,
  };
}
