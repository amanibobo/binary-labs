import { signOut } from "@/app/actions";
import { Button } from "@/components/ui/button";
import type { LabMember } from "@/lib/domain";
import type { SourceState } from "@/lib/source-state";
import { DropboxSection } from "./dropbox-section";
import { MembersSection } from "./members-section";

const DROPBOX_NOTICES = {
  denied: "Dropbox access wasn't granted, so nothing was connected.",
  expired: "That Dropbox sign-in took too long or came from another tab. Try connecting again.",
  failed: "We couldn't finish connecting Dropbox. Try again.",
} as const;

export type DropboxNotice = keyof typeof DROPBOX_NOTICES;

export function LabView({
  labName,
  email,
  isAdmin,
  source,
  members,
  notice,
}: {
  labName: string;
  email: string;
  isAdmin: boolean;
  source: SourceState;
  members: LabMember[];
  notice: DropboxNotice | null;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-24 sm:px-6 sm:pt-12">
      <h1 className="text-heading-large">Settings</h1>
      <p className="mt-1 text-paragraph-medium text-content-tertiary">{labName}</p>
      <section aria-labelledby="dropbox-heading" className="mt-8 rounded-lg border border-border-opaque bg-background-primary p-5 sm:p-6">
        <h2 id="dropbox-heading" className="mb-3 text-heading-xsmall">
          Dropbox
        </h2>
        {notice === null ? null : (
          <p role="alert" className="mb-4 text-paragraph-medium text-content-primary">
            {DROPBOX_NOTICES[notice]}
          </p>
        )}
        <DropboxSection initial={source} isAdmin={isAdmin} />
      </section>
      <section aria-labelledby="members-heading" className="mt-10">
        <h2 id="members-heading" className="mb-3 text-heading-xsmall">
          Members
        </h2>
        <MembersSection members={members} isAdmin={isAdmin} />
      </section>
      <section aria-labelledby="account-heading" className="mt-10">
        <h2 id="account-heading" className="mb-1 text-heading-xsmall">
          Account
        </h2>
        <p className="text-paragraph-medium text-content-tertiary">Signed in as {email}</p>
        <form action={signOut} className="mt-3">
          <Button type="submit" variant="secondary">
            Sign out
          </Button>
        </form>
      </section>
    </div>
  );
}
