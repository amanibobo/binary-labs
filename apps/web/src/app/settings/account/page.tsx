import { AccountSection } from "../account-section";
import { renderSettings, settingsMetadata } from "../settings-shell";

export const metadata = settingsMetadata("account");

export default function AccountPage() {
  return renderSettings("account", async ({ lab, user }) => <AccountSection email={user.email} labName={lab.name} isAdmin={lab.role === "admin"} />);
}
