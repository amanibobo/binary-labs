import { AppShell } from "@/components/app-shell";
import { QuestionsView } from "@/components/ask/questions-view";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { fixtureViewer } from "@/fixtures/answers";
import { FixtureAskApi } from "@/fixtures/fixture-ask-api";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures } from "@/fixtures/gate";

// The Questions page over the fixture lab's twelve questions.
export default async function QuestionsFixture() {
  requireFixtures();
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <FixtureAskApi answer="answer">
        <AppShell shell={fixtureShell} location={{ section: "search" }}>
          <QuestionsView viewerId={fixtureViewer} />
        </AppShell>
      </FixtureAskApi>
    </FixtureLabApi>
  );
}
