import { loadMembers } from "@/lib/lab-data";
import { loadPeopleAccounts } from "@/lib/people-accounts-store";
import { MembersSection } from "../members-section";
import { renderSettings, settingsMetadata } from "../settings-shell";

export const metadata = settingsMetadata("members");

export default function MembersPage() {
  return renderSettings("members", async ({ supabase, lab, user }) => {
    const [members, people] = await Promise.all([loadMembers(supabase, lab.id), loadPeopleAccounts(supabase, lab.id)]);
    return <MembersSection members={members} isAdmin={lab.role === "admin"} email={user.email} people={people} />;
  });
}
