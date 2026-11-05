import { loadInstruments } from "@/lib/lab-data";
import { InstrumentsSection } from "../instruments-section";
import { renderSettings, settingsMetadata } from "../settings-shell";

export const metadata = settingsMetadata("instruments");

export default function InstrumentsPage() {
  return renderSettings("instruments", async ({ supabase, lab }) => (
    <InstrumentsSection instruments={await loadInstruments(supabase, lab.id)} isAdmin={lab.role === "admin"} shownCode={null} />
  ));
}
