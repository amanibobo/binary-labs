import type { ReactNode } from "react";
import { z } from "zod";
import { AccountSection } from "@/app/settings/account-section";
import { AppearanceSection } from "@/app/settings/appearance-section";
import { DropboxSection } from "@/app/settings/dropbox-section";
import { GeneralSection } from "@/app/settings/general-section";
import { InstrumentsSection } from "@/app/settings/instruments-section";
import { LabListSection } from "@/app/settings/lab-list-section";
import { MembersSection } from "@/app/settings/members-section";
import { DropboxNotice, SettingsSection } from "@/app/settings/sections";
import { SettingsFrame } from "@/app/settings/settings-frame";
import { AppShell } from "@/components/app-shell";
import { disconnectedSource, experiments, fixtureShell, members, people, scanningSource } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures } from "@/fixtures/gate";
import { fixturePairing, instruments, waitingInstrument } from "@/fixtures/instruments";

// /dev/fixtures/settings[/<section>]?state=connect|scanning|disconnected&role=admin|member&code=shown|paired&dropbox=<notice>
const State = z.enum(["connect", "scanning", "disconnected"]).catch("scanning");
const Role = z.enum(["admin", "member"]).catch("admin");
const Section = SettingsSection.nullable().catch(null);
const Code = z.enum(["shown", "paired"]).optional().catch(undefined);

const SOURCES = { connect: { kind: "not_connected" as const }, scanning: scanningSource, disconnected: disconnectedSource };
const LAB = "Okafor Lab";

type Props = {
  params: Promise<{ section?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SettingsFixture({ params, searchParams }: Props) {
  requireFixtures();
  const [{ section: path }, query] = await Promise.all([params, searchParams]);
  const section = Section.parse(path?.[0] ?? null);
  const state = State.parse(query.state);
  const role = Role.parse(query.role);
  const code = Code.parse(query.code);
  const isAdmin = role === "admin";
  const source = SOURCES[state];
  const email = isAdmin ? "a.okafor@university.edu" : "priya.n@university.edu";
  const shown = code === "shown" ? [waitingInstrument, ...instruments.slice(1)] : instruments;
  // The section links keep the fixture's state, so clicking through stays in the same lab.
  const kept = new URLSearchParams(Object.entries({ state: query.state, role: query.role }).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  const suffix = kept.size === 0 ? "" : `?${kept}`;

  const body = (s: SettingsSection): ReactNode => {
    switch (s) {
      case "general":
        return <GeneralSection labName={LAB} isAdmin={isAdmin} />;
      case "members":
        return <MembersSection members={state === "connect" ? members.slice(0, 1) : members} isAdmin={isAdmin} email={email} />;
      case "dropbox":
        return <DropboxSection initial={source} isAdmin={isAdmin} notice={query.dropbox === undefined ? null : DropboxNotice.parse(query.dropbox)} />;
      case "instruments":
        return <InstrumentsSection instruments={state === "connect" ? [] : shown} isAdmin={isAdmin} shownCode={code === undefined ? null : fixturePairing} />;
      case "experiments":
        return <LabListSection kind="experiments" entries={state === "connect" ? [] : experiments} isAdmin={isAdmin} />;
      case "people":
        return <LabListSection kind="people" entries={state === "connect" ? [] : people} isAdmin={isAdmin} />;
      case "account":
        return <AccountSection email={email} labName={LAB} isAdmin={isAdmin} />;
      case "appearance":
        return <AppearanceSection />;
      default: {
        const _exhaustive: never = s;
        return _exhaustive;
      }
    }
  };

  return (
    <FixtureLabApi mode="hybrid" source={source}>
      <AppShell shell={{ ...fixtureShell, isAdmin, email }} location={{ section: "lab" }}>
        <SettingsFrame section={section} labName={LAB} base="/dev/fixtures/settings" query={suffix}>
          {body(section ?? "general")}
        </SettingsFrame>
      </AppShell>
    </FixtureLabApi>
  );
}
