import { signOut } from "@/app/actions";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { dataSurface } from "@/components/ui/data-table";
import { cn } from "@/lib/cn";
import type { Experiment, LabMember, Person } from "@/lib/domain";
import type { SourceState } from "@/lib/source-state";
import { DropboxSection } from "./dropbox-section";
import { LabListSection } from "./lab-list-section";
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
  experiments,
  people,
  notice,
}: {
  labName: string;
  email: string;
  isAdmin: boolean;
  source: SourceState;
  members: LabMember[];
  experiments: Experiment[];
  people: Person[];
  notice: DropboxNotice | null;
}) {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 pt-8 pb-24 sm:px-8 sm:pt-16">
      <div className="mb-2">
        <h1 className="text-heading-large">Settings</h1>
        <p className="mt-1 text-paragraph-medium text-content-tertiary">{labName}</p>
      </div>
      <section aria-labelledby="dropbox-heading" className={cn(dataSurface, "p-5 sm:p-6")}>
        <h2 id="dropbox-heading" className="mb-4 text-heading-xsmall">
          Dropbox
        </h2>
        {notice === null ? null : (
          <p role="alert" className="mb-4 text-paragraph-medium text-content-primary">
            {DROPBOX_NOTICES[notice]}
          </p>
        )}
        <DropboxSection initial={source} isAdmin={isAdmin} />
      </section>
      <section aria-labelledby="experiments-heading" className={dataSurface}>
        <h2 id="experiments-heading" className="px-5 pt-5 pb-3 text-heading-xsmall sm:px-6 sm:pt-6">
          Experiments
        </h2>
        <LabListSection kind="experiments" entries={experiments} isAdmin={isAdmin} />
      </section>
      <section aria-labelledby="people-heading" className={dataSurface}>
        <h2 id="people-heading" className="px-5 pt-5 pb-3 text-heading-xsmall sm:px-6 sm:pt-6">
          People
        </h2>
        <LabListSection kind="people" entries={people} isAdmin={isAdmin} />
      </section>
      <section aria-labelledby="members-heading" className={dataSurface}>
        <h2 id="members-heading" className="px-5 pt-5 pb-3 text-heading-xsmall sm:px-6 sm:pt-6">
          Members
        </h2>
        <MembersSection members={members} isAdmin={isAdmin} />
      </section>
      <section aria-labelledby="account-heading" className={cn(dataSurface, "flex flex-wrap items-center gap-4 p-5 sm:p-6")}>
        <Avatar label={email} />
        <div className="min-w-0 flex-1">
          <h2 id="account-heading" className="text-heading-xsmall">
            Account
          </h2>
          <p className="truncate text-paragraph-medium text-content-tertiary">Signed in as {email}</p>
        </div>
        <form action={signOut}>
          <Button type="submit" variant="secondary">
            Sign out
          </Button>
        </form>
      </section>
    </div>
  );
}
