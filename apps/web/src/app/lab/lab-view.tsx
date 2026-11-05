import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "@/app/actions";
import { SettingsArt } from "@/components/art/settings-art";
import { ChevronSmallIcon } from "@/components/icons/drawn";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { dataSurface } from "@/components/ui/data-table";
import { cn } from "@/lib/cn";
import type { Experiment, LabMember, Person } from "@/lib/domain";
import { instrumentsLine, type Instrument } from "@/lib/instruments";
import type { SourceState } from "@/lib/source-state";
import { AppearanceSection, AppearanceStatus } from "./appearance-section";
import type { PairingCode } from "./actions";
import { AREA_COPY, areaHref, type SettingsArea } from "./areas";
import { DeleteLabSection } from "./delete-lab-section";
import { DropboxSection, DropboxStatus } from "./dropbox-section";
import { InstrumentsSection } from "./instruments-section";
import { LabListSection } from "./lab-list-section";
import { MembersSection } from "./members-section";

const DROPBOX_NOTICES = {
  denied: "Dropbox access wasn't granted, so nothing was connected.",
  expired: "That Dropbox sign-in took too long or came from another tab. Try connecting again.",
  failed: "We couldn't finish connecting Dropbox. Try again.",
} as const;

export type DropboxNotice = keyof typeof DROPBOX_NOTICES;

type LabViewProps = {
  area: SettingsArea | null;
  labName: string;
  email: string;
  isAdmin: boolean;
  source: SourceState;
  members: LabMember[];
  experiments: Experiment[];
  people: Person[];
  instruments: Instrument[];
  // Fixtures only: a pairing code as if an admin had just added an instrument.
  shownCode?: PairingCode;
  notice: DropboxNotice | null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const count = (n: number, one: string, many: string) => (n === 0 ? "None yet" : plural(n, one, many));

function membersLine(members: LabMember[]): string {
  const admins = members.filter((m) => m.role === "admin").length;
  const others = members.length - admins;
  const line = plural(admins, "admin", "admins");
  return others === 0 ? line : `${line}, ${plural(others, "member", "members")}`;
}

export function LabView(props: LabViewProps) {
  const { area, isAdmin } = props;
  // Deleting is admin-only, so members asking for it get the overview.
  if (area === null || (area === "delete" && !isAdmin)) return <Overview {...props} />;
  return <AreaView {...props} area={area} />;
}

function Overview({ labName, isAdmin, source, members, experiments, people, instruments }: LabViewProps) {
  const tiles: { area: SettingsArea; status: ReactNode }[] = [
    { area: "dropbox", status: <DropboxStatus initial={source} /> },
    { area: "instruments", status: instrumentsLine(instruments) },
    { area: "experiments", status: count(experiments.length, "experiment", "experiments") },
    { area: "people", status: count(people.length, "person", "people") },
    { area: "members", status: membersLine(members) },
    { area: "account", status: isAdmin ? "You're an admin" : "You're a member" },
    { area: "appearance", status: <AppearanceStatus /> },
  ];
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-8 pb-24 sm:px-8 sm:pt-14">
      <h1 className="text-heading-large">Settings</h1>
      <p className="mt-1 text-paragraph-medium text-content-tertiary">{labName}</p>
      <ul className="mt-8 grid grid-cols-2 gap-2 sm:mt-10 sm:grid-cols-3 sm:gap-4">
        {tiles.map(({ area, status }) => (
          <li key={area}>
            <Link
              href={areaHref(area)}
              className="group flex h-full flex-col items-center rounded-card border border-transparent px-3 pt-4 pb-4 text-center transition-colors duration-150 ease-out hover:border-border-opaque hover:bg-background-raised focus-visible:bg-background-raised sm:px-6 sm:pt-6"
            >
              <SettingsArt area={area} className="w-full max-w-28 transition-transform duration-200 ease-out group-hover:-translate-y-0.5 sm:max-w-36" />
              <span className="mt-4 text-label-large text-content-primary">{AREA_COPY[area].title}</span>
              <span className="mt-1 line-clamp-2 w-full text-paragraph-small text-content-tertiary">{status}</span>
            </Link>
          </li>
        ))}
      </ul>
      {isAdmin ? (
        <Link
          href={areaHref("delete")}
          className="mt-10 flex min-h-11 items-center gap-4 border-t border-border-opaque pt-6 text-content-tertiary transition-colors duration-150 ease-out hover:text-content-primary sm:mt-14"
        >
          <SettingsArt area="delete" className="w-10 shrink-0 opacity-80" />
          <span className="min-w-0">
            <span className="block text-label-medium">{AREA_COPY.delete.title}</span>
            <span className="block text-paragraph-small">{AREA_COPY.delete.helper}</span>
          </span>
        </Link>
      ) : null}
    </div>
  );
}

function AreaView(props: LabViewProps & { area: SettingsArea }) {
  const { area } = props;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-4 pb-24 sm:px-8 sm:pt-8">
      <Link
        href="/lab"
        className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-control pr-2 text-label-medium text-content-tertiary transition-colors duration-150 ease-out hover:text-content-primary"
      >
        <ChevronSmallIcon className="size-5 rotate-180" />
        Settings
      </Link>
      <div className="mt-3 flex items-center gap-4 sm:mt-4 sm:gap-6">
        <SettingsArt area={area} className={cn("shrink-0", area === "delete" ? "w-14 opacity-80 sm:w-16" : "w-20 sm:w-28")} />
        <div className="min-w-0">
          <h1 className="text-heading-medium">{AREA_COPY[area].title}</h1>
          <p className="mt-1 text-paragraph-medium text-content-tertiary">{AREA_COPY[area].helper}</p>
        </div>
      </div>
      <div className="mt-8">
        <AreaBody {...props} />
      </div>
    </div>
  );
}

function AreaBody({ area, labName, email, isAdmin, source, members, experiments, people, instruments, shownCode, notice }: LabViewProps & { area: SettingsArea }) {
  switch (area) {
    case "dropbox":
      return (
        <>
          {notice === null ? null : (
            <p role="alert" className="mb-4 text-paragraph-medium text-content-primary">
              {DROPBOX_NOTICES[notice]}
            </p>
          )}
          <DropboxSection initial={source} isAdmin={isAdmin} />
        </>
      );
    case "instruments":
      return <InstrumentsSection instruments={instruments} isAdmin={isAdmin} shownCode={shownCode ?? null} />;
    case "experiments":
      return <LabListSection kind="experiments" entries={experiments} isAdmin={isAdmin} />;
    case "people":
      return <LabListSection kind="people" entries={people} isAdmin={isAdmin} />;
    case "members":
      return <MembersSection members={members} isAdmin={isAdmin} />;
    case "account":
      return (
        <div className={cn(dataSurface, "flex flex-wrap items-center gap-4 p-5 sm:p-6")}>
          <Avatar label={email} />
          <div className="min-w-0 flex-1">
            <p className="text-label-medium [overflow-wrap:anywhere] text-content-primary">{email}</p>
            <p className="text-paragraph-small text-content-tertiary">
              {isAdmin ? "Admin" : "Member"} of {labName}
            </p>
          </div>
          <form action={signOut}>
            <Button type="submit" variant="secondary">
              Sign out
            </Button>
          </form>
        </div>
      );
    case "appearance":
      return <AppearanceSection />;
    case "delete":
      return <DeleteLabSection labName={labName} />;
    default: {
      const _exhaustive: never = area;
      return _exhaustive;
    }
  }
}
