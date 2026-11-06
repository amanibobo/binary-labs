import { loadMembers } from "@/lib/lab-data";
import { MembersSection } from "../members-section";
import { renderSettings, settingsMetadata } from "../settings-shell";

export const metadata = settingsMetadata("members");

export default function MembersPage() {
  return renderSettings("members", async ({ supabase, lab, user }) => (
    <MembersSection members={await loadMembers(supabase, lab.id)} isAdmin={lab.role === "admin"} email={user.email} />
  ));
}
