import { z } from "zod";
import { LabView } from "@/app/lab/lab-view";
import { AppShell } from "@/components/app-shell";
import { members, scanningSource } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";

const State = z.enum(["connect", "scanning"]).catch("scanning");

export default async function LabFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const state = State.parse((await searchParams).state);
  const source = state === "connect" ? { kind: "not_connected" as const } : scanningSource;
  return (
    <FixtureLabApi mode="hybrid" source={source}>
      <AppShell labName="Okafor Lab" email="a.okafor@university.edu" current="lab">
        <LabView
          labName="Okafor Lab"
          email="a.okafor@university.edu"
          isAdmin
          source={source}
          members={state === "connect" ? members.slice(0, 1) : members}
          notice={null}
        />
      </AppShell>
    </FixtureLabApi>
  );
}
