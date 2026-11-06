import { GeneralSection } from "./general-section";
import { renderSettings, settingsMetadata } from "./settings-shell";

export const metadata = settingsMetadata(null);

// The section list on a phone; on a desktop the list with General open beside it.
export default function SettingsPage() {
  return renderSettings(null, async ({ lab }) => <GeneralSection labName={lab.name} isAdmin={lab.role === "admin"} />);
}
