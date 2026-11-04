import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ProtocolEditor } from "@/components/protocols/protocol-editor";
import { HistoryView } from "@/components/protocols/history-view";
import { ProtocolListView } from "@/components/protocols/protocol-list-view";
import { ProtocolView } from "@/components/protocols/protocol-view";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { authors, history, linkedFiles, protocolList, purification, purificationV2, startFile } from "@/fixtures/protocols";

// One fixture route for every protocol screen: ?view=list|empty|page|old|edit|stale|new|from|history.
const View = z.enum(["list", "empty", "page", "old", "edit", "stale", "new", "from", "history"]).catch("list");

export default async function ProtocolsFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  return (
    <FixtureLabApi mode="hybrid" source={doneSource} saves={view === "stale" ? "stale" : "saved"}>
      <AppShell shell={fixtureShell} location={{ section: "protocols" }}>
        <Screen view={view} />
      </AppShell>
    </FixtureLabApi>
  );
}

function Screen({ view }: { view: z.infer<typeof View> }) {
  switch (view) {
    case "list":
      return <ProtocolListView protocols={protocolList} authors={authors} initialFilter="all" />;
    case "empty":
      return <ProtocolListView protocols={[]} authors={authors} initialFilter="all" />;
    case "page":
      return <ProtocolView page={purification} files={linkedFiles} authors={authors} isAdmin />;
    case "old":
      return <ProtocolView page={purificationV2} files={linkedFiles} authors={authors} isAdmin />;
    case "edit":
    case "stale":
      return <ProtocolEditor mode={{ kind: "edit", page: purification }} authors={authors} />;
    case "new":
      return <ProtocolEditor mode={{ kind: "create", from: null, title: "" }} authors={authors} />;
    case "from":
      return <ProtocolEditor mode={{ kind: "create", from: startFile, title: "P450 purification v3" }} authors={authors} />;
    case "history":
      return <HistoryView page={purification} versions={history} authors={authors} />;
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
