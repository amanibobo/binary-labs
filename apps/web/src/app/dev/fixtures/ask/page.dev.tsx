import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { SearchHome } from "@/components/search/search-home";
import { doneSource, experiments, fixtureShell, people, recentFiles } from "@/fixtures/data";
import { fixtureViewer, recentQuestions } from "@/fixtures/answers";
import { FixtureAskApi } from "@/fixtures/fixture-ask-api";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";

// Asking the lab on the Search page: ?view=answer|no-answer|limit|unavailable|home, with the
// question in ?q. Screenshots press "Ask the lab"; home shows the recent questions.
const View = z.enum(["answer", "no-answer", "limit", "unavailable", "home"]).catch("answer");

export default async function AskFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  const answer = view === "no-answer" || view === "limit" ? view : "answer";
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <FixtureAskApi answer={answer}>
        <AppShell shell={fixtureShell} location={{ section: "search" }}>
          <SearchHome
            recent={recentFiles}
            source={doneSource}
            isAdmin
            lists={{ experiments, people }}
            ask={{ available: view !== "unavailable", recent: recentQuestions, openSuggestions: 2, viewerId: fixtureViewer }}
          />
        </AppShell>
      </FixtureAskApi>
    </FixtureLabApi>
  );
}
