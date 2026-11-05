import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { UploadView } from "@/components/uploads/upload-view";
import { doneSource, experiments, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { fixtureOnboarding, OnboardingFixture } from "@/fixtures/onboarding";

const State = z.enum(["earlier", "first"]).catch("earlier");

export default async function UploadFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const params = await searchParams;
  const state = State.parse(params.state);
  const onboarding = fixtureOnboarding(OnboardingFixture.parse(params.onboarding));
  return (
    <FixtureLabApi mode="hybrid" source={doneSource} earlierUploads={state === "earlier"}>
      <AppShell shell={{ ...fixtureShell, onboarding }} location={{ section: "upload" }}>
        <UploadView
          experiments={state === "first" ? [] : ["P450 BM3", ...experiments.map((e) => e.name).filter((n) => n !== "P450 BM3")]}
          personName="Priya Nair"
        />
      </AppShell>
    </FixtureLabApi>
  );
}
