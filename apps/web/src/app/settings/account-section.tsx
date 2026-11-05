import { signOut } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsRow } from "./settings-frame";

const value = "text-paragraph-medium text-content-secondary [overflow-wrap:anywhere]";

export function AccountSection({ email, labName, isAdmin }: { email: string; labName: string; isAdmin: boolean }) {
  return (
    <SettingsGroup>
      <SettingsRow label="Email" action={<span className={value}>{email}</span>} />
      <SettingsRow label="Role" action={<span className={value}>{isAdmin ? "Admin" : "Member"} of {labName}</span>}>
        {isAdmin ? "You can change every setting here." : "An admin connects Dropbox and instruments and invites people."}
      </SettingsRow>
      <SettingsRow
        label="Sign out"
        action={
          <form action={signOut}>
            <Button type="submit" variant="secondary" size="compact">
              Sign out
            </Button>
          </form>
        }
      />
    </SettingsGroup>
  );
}
