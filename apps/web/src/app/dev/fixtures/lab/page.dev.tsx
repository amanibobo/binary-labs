import { z } from "zod";
import { LabView } from "@/app/lab/lab-view";
import { AppShell } from "@/components/app-shell";
import { disconnectedSource, experiments, fixtureShell, members, people, scanningSource } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";

const State = z.enum(["connect", "scanning", "disconnected"]).catch("scanning");
const Role = z.enum(["admin", "member"]).catch("admin");

const SOURCES = { connect: { kind: "not_connected" as const }, scanning: scanningSource, disconnected: disconnectedSource };

export default async function LabFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const params = await searchParams;
  const state = State.parse(params.state);
  const role = Role.parse(params.role);
  const source = SOURCES[state];
  return (
    <FixtureLabApi mode="hybrid" source={source}>
      <AppShell shell={fixtureShell} location={{ section: "lab" }}>
        <LabView
          labName="Okafor Lab"
          email="a.okafor@university.edu"
          isAdmin={role === "admin"}
          source={source}
          members={state === "connect" ? members.slice(0, 1) : members}
          experiments={state === "connect" ? [] : experiments}
          people={state === "connect" ? [] : people}
          notice={null}
        />
      </AppShell>
    </FixtureLabApi>
  );
}
