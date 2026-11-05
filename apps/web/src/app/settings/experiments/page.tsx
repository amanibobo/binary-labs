import { loadExperiments } from "@/lib/lab-data";
import { LabListSection } from "../lab-list-section";
import { renderSettings, settingsMetadata } from "../settings-shell";

export const metadata = settingsMetadata("experiments");

export default function ExperimentsPage() {
  return renderSettings("experiments", async ({ supabase, lab }) => (
    <LabListSection kind="experiments" entries={await loadExperiments(supabase, lab.id)} isAdmin={lab.role === "admin"} />
  ));
}
