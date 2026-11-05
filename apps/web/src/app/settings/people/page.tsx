import { loadPeople } from "@/lib/lab-data";
import { LabListSection } from "../lab-list-section";
import { renderSettings, settingsMetadata } from "../settings-shell";

export const metadata = settingsMetadata("people");

export default function PeoplePage() {
  return renderSettings("people", async ({ supabase, lab }) => (
    <LabListSection kind="people" entries={await loadPeople(supabase, lab.id)} isAdmin={lab.role === "admin"} />
  ));
}
