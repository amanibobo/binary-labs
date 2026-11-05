import { GeneralSection } from "../general-section";
import { renderSettings, settingsMetadata } from "../settings-shell";

export const metadata = settingsMetadata("general");

export default function GeneralPage() {
  return renderSettings("general", async ({ lab }) => <GeneralSection labName={lab.name} isAdmin={lab.role === "admin"} />);
}
