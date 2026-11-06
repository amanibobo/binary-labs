import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ProtocolEditor } from "@/components/protocols/protocol-editor";
import { HistoryView } from "@/components/protocols/history-view";
import { ProtocolListView } from "@/components/protocols/protocol-list-view";
import { ProtocolView } from "@/components/protocols/protocol-view";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { openForPage, openNewPage } from "@/fixtures/talk-throughs";
import { pageVideos } from "@/fixtures/videos";
import { fixtureHit, savedCharts } from "@/fixtures/charts";
import type { ProtocolVideo } from "@/lib/videos";
import { purificationPlans } from "@/fixtures/calendar";

const NO_PLANS = { entries: [], more: false };
import { authors, history, linkedFiles, protocolList, purification, purificationV2, startFile } from "@/fixtures/protocols";

// One fixture route for every protocol screen: ?view=list|empty|page|old|edit|stale|new|from|history,
// videos|no-videos for a page with one playable video or none, and charts for one with charts.
const View = z
  .enum(["list", "empty", "page", "old", "edit", "stale", "new", "from", "history", "videos", "no-videos", "charts"])
  .catch("list");

export default async function ProtocolsFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  return (
    <FixtureLabApi mode="hybrid" source={doneSource} saves={view === "stale" ? "stale" : "saved"} videos={videosFor(view)}>
      <AppShell shell={fixtureShell} location={{ section: "protocols" }}>
        <Screen view={view} />
      </AppShell>
    </FixtureLabApi>
  );
}

function Screen({ view }: { view: z.infer<typeof View> }) {
  switch (view) {
    case "list":
      return <ProtocolListView protocols={protocolList} authors={authors} initialFilter="all" talkThroughs={openNewPage} />;
    case "empty":
      return <ProtocolListView protocols={[]} authors={authors} initialFilter="all" talkThroughs={[]} />;
    case "page":
      return <ProtocolView page={purification} files={linkedFiles} authors={authors} isAdmin talkThroughs={openForPage} videos={pageVideos} charts={[]} plans={{ entries: purificationPlans, more: false }} />;
    case "videos":
    case "no-videos":
      return <ProtocolView page={purification} files={linkedFiles} authors={authors} isAdmin talkThroughs={[]} videos={videosFor(view)} charts={[]} plans={NO_PLANS} />;
    case "charts":
      return (
        <ProtocolView page={purification} files={linkedFiles} authors={authors} isAdmin talkThroughs={[]} videos={[]} charts={pageCharts()} plans={NO_PLANS} />
      );
    case "old":
      return <ProtocolView page={purificationV2} files={linkedFiles} authors={authors} isAdmin talkThroughs={[]} videos={pageVideos.slice(0, 1)} charts={[]} plans={NO_PLANS} />;
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

function pageCharts() {
  return savedCharts
    .filter((c) => c.protocolId === purification.protocolId)
    .map((chart) => {
      const location = fixtureHit(chart.sha256).locations[0];
      return { chart, file: { name: location.originalName, locationId: location.id } };
    });
}

function videosFor(view: z.infer<typeof View>): ProtocolVideo[] {
  if (view === "videos") return pageVideos.slice(0, 1);
  if (view === "no-videos") return [];
  return pageVideos;
}
