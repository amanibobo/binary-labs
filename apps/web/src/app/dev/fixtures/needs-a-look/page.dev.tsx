import { z } from "zod";
import { NeedsLookView } from "@/app/needs-a-look/needs-look-view";
import { AppShell } from "@/components/app-shell";
import { doneSource, fixtureShell, needsLookFiles } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";

const State = z.enum(["queue", "empty"]).catch("queue");

export default async function NeedsLookFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const files = State.parse((await searchParams).state) === "empty" ? [] : needsLookFiles;
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <AppShell shell={{ ...fixtureShell, needsLookCount: files.length }} location={{ section: "needs-look" }}>
        <NeedsLookView files={files} />
      </AppShell>
    </FixtureLabApi>
  );
}
