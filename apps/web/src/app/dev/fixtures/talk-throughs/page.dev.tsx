import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ProtocolEditor } from "@/components/protocols/protocol-editor";
import { Recorder } from "@/components/talk-throughs/recorder";
import { TalkThroughView } from "@/components/talk-throughs/talk-through-view";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { authors, purification } from "@/fixtures/protocols";
import { DRAFT_BODY, DRAFT_TITLE, talkThrough, videoTalkThrough, type FixtureStatus } from "@/fixtures/talk-throughs";
import { editorStart } from "@/lib/talk-throughs";

// Every talk-through screen: ?view=record|record-new, a status (transcribing|drafting|ready|
// no-draft|failed), edit|edit-new for the editor filled with the drafted steps, or steps
// drafted from a video on the page: video-waiting (for its transcript), video-ready and
// video-dismissed.
const View = z
  .enum(["record", "record-new", "transcribing", "drafting", "ready", "no-draft", "failed", "edit", "edit-new", "video-waiting", "video-ready", "video-dismissed"])
  .catch("record");

export default async function TalkThroughsFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  const status: FixtureStatus = isStatus(view) ? view : "ready";
  const shown = videoView(view) ?? talkThrough(status);
  return (
    <FixtureLabApi mode="hybrid" source={doneSource} talkThrough={shown}>
      <AppShell shell={fixtureShell} location={{ section: "protocols" }}>
        <Screen view={view} />
      </AppShell>
    </FixtureLabApi>
  );
}

function isStatus(view: z.infer<typeof View>): view is FixtureStatus {
  return view === "transcribing" || view === "drafting" || view === "ready" || view === "no-draft" || view === "failed";
}

function videoView(view: z.infer<typeof View>) {
  if (view === "video-waiting") return videoTalkThrough("transcribing");
  if (view === "video-ready") return videoTalkThrough("ready");
  if (view === "video-dismissed") return videoTalkThrough("ready", { dismissed: true });
  return null;
}

function Screen({ view }: { view: z.infer<typeof View> }) {
  switch (view) {
    case "record":
      return <Recorder target={{ kind: "page", protocolId: purification.protocolId, baseVersionId: purification.id }} pageTitle={purification.title} />;
    case "record-new":
      return <Recorder target={{ kind: "new", pageKind: "protocol" }} pageTitle={null} />;
    case "transcribing":
    case "drafting":
    case "ready":
    case "no-draft":
    case "failed":
      return <TalkThroughView initial={talkThrough(view)} authors={authors} />;
    case "video-waiting":
    case "video-ready":
    case "video-dismissed": {
      const tt = videoView(view);
      return tt === null ? null : <TalkThroughView initial={tt} authors={authors} />;
    }
    case "edit":
    case "edit-new": {
      const tt = talkThrough("ready", { forPage: view === "edit" });
      const start = editorStart(tt, "steps") ?? { title: DRAFT_TITLE, body: DRAFT_BODY, from: "steps" as const };
      return (
        <ProtocolEditor
          mode={{ kind: "talk_through", talkThroughId: tt.id, base: view === "edit" ? purification : null, pageKind: "protocol", ...start }}
          authors={authors}
        />
      );
    }
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
