import { AppearanceSection } from "../appearance-section";
import { renderSettings, settingsMetadata } from "../settings-shell";

export const metadata = settingsMetadata("appearance");

export default function AppearancePage() {
  return renderSettings("appearance", async () => <AppearanceSection />);
}
