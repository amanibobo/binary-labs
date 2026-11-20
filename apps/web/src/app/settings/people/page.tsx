import { loadMembers } from "@/lib/lab-data";
import { loadPeopleAccounts } from "@/lib/people-accounts-store";
import { PeopleSection } from "../people-section";
import { renderSettings, settingsMetadata } from "../settings-shell";

export const metadata = settingsMetadata("people");

export default function PeoplePage() {
  return renderSettings("people", async ({ supabase, lab }) => {
    const [people, members] = await Promise.all([loadPeopleAccounts(supabase, lab.id), loadMembers(supabase, lab.id)]);
    return <PeopleSection people={people} members={members} isAdmin={lab.role === "admin"} />;
  });
}
