import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { CheckEditor } from "@/components/flags/check-editor";
import { FlagView } from "@/components/flags/flag-view";
import { FlagsView } from "@/components/flags/flags-view";
import { ProtocolView } from "@/components/protocols/protocol-view";
import { BRADFORD, fixtureHit } from "@/fixtures/charts";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { bradfordAssay, bradfordChecks, bradfordUsefulness, CURVE, fixtureFlags, flagById } from "@/fixtures/flags";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { authors } from "@/fixtures/protocols";

// Checks and flags: ?view=list|empty (the Flags queue), flag (a curve fit flag), control (a
// blank out of range), answered, wrong (answering wrong, which offers to edit the range),
// checks (the check editor), checks-wrong (the editor opened on the check from a wrong flag),
// checks-empty and protocol (a protocol page with its checks and flags).
const View = z
  .enum(["list", "empty", "flag", "control", "answered", "wrong", "checks", "checks-wrong", "checks-empty", "protocol"])
  .catch("list");

const [curveFlag, controlFlag, answeredFlag] = fixtureFlags;

export default async function FlagsFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  const section = view.startsWith("checks") || view === "protocol" ? "protocols" : "flags";
  return (
    <FixtureLabApi mode="hybrid" source={doneSource}>
      <AppShell shell={fixtureShell} location={{ section }}>
        <Screen view={view} />
      </AppShell>
    </FixtureLabApi>
  );
}

function Screen({ view }: { view: z.infer<typeof View> }) {
  switch (view) {
    case "list":
      return <FlagsView flags={fixtureFlags} />;
    case "empty":
      return <FlagsView flags={[]} />;
    case "flag":
      return <FlagView flag={curveFlag ?? flagById("")} authors={authors} />;
    case "control":
      return <FlagView flag={controlFlag ?? flagById("")} authors={authors} />;
    case "answered":
      return <FlagView flag={answeredFlag ?? flagById("")} authors={authors} />;
    case "wrong":
      return <FlagView flag={curveFlag ?? flagById("")} authors={authors} initialReview="wrong" />;
    case "checks":
      return <CheckEditor page={bradfordAssay} checks={bradfordChecks} usefulness={bradfordUsefulness} focus={null} />;
    case "checks-wrong":
      return <CheckEditor page={bradfordAssay} checks={bradfordChecks} usefulness={bradfordUsefulness} focus={CURVE} />;
    case "checks-empty":
      return <CheckEditor page={bradfordAssay} checks={[]} usefulness={null} focus={null} />;
    case "protocol":
      return (
        <ProtocolView
          page={bradfordAssay}
          files={[fixtureHit(BRADFORD)]}
          plans={{ entries: [], more: false }}
          authors={authors}
          isAdmin
          talkThroughs={[]}
          videos={[]}
          charts={[]}
          checks={{ checks: bradfordChecks, flags: fixtureFlags.filter((f) => f.answer === null), usefulness: bradfordUsefulness }}
        />
      );
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}
