import { FailureTypesSection } from "@/components/runs/failure/failure-types";
import { loadFailureList } from "@/lib/run-failure-store";
import { renderSettings, settingsMetadata } from "../settings-shell";

export const metadata = settingsMetadata("failure-types");

export default function FailureTypesPage() {
  return renderSettings("failure-types", async ({ supabase }) => <FailureTypesSection list={await loadFailureList(supabase)} />);
}
