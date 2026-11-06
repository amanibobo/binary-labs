import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { SuggestionList } from "@/components/ask/suggestion-list";
import { SuggestionView } from "@/components/ask/suggestion-view";
import { fixtureViewer, labelFixes, protocolEdit } from "@/fixtures/answers";
import { FixtureAskApi } from "@/fixtures/fixture-ask-api";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { authors } from "@/fixtures/protocols";
import type { Suggestion } from "@/lib/suggestions";

// Suggestions waiting for approval: ?view=protocol|labels|approved|stale|list.
const View = z.enum(["protocol", "labels", "approved", "stale", "list"]).catch("protocol");

function suggestionFor(view: Exclude<z.infer<typeof View>, "list">): Suggestion {
  switch (view) {
    case "protocol":
      return protocolEdit;
    case "stale":
      return { ...protocolEdit, stale: true };
    case "labels":
      return labelFixes;
    case "approved":
      return {
        ...labelFixes,
        decision: { state: "approved", decidedBy: fixtureViewer, decidedAt: "2026-11-05T14:30:00Z" },
        changes: labelFixes.changes.map((c, i) => ({ ...c, applied: i !== 1 })),
      };
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

export default async function SuggestionsFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <FixtureAskApi answer="answer">
        <AppShell shell={fixtureShell} location={{ section: view === "protocol" || view === "stale" ? "protocols" : "search" }}>
          {view === "list" ? (
            <SuggestionList
              items={[protocolEdit, labelFixes].map((s) => ({ id: s.id, kind: s.kind, summary: s.summary, createdAt: s.createdAt }))}
            />
          ) : (
            <SuggestionView suggestion={suggestionFor(view)} authors={authors} viewerId={fixtureViewer} />
          )}
        </AppShell>
      </FixtureAskApi>
    </FixtureLabApi>
  );
}
