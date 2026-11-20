import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { DebriefFlow, type Screen } from "@/components/runs/debrief/debrief-flow";
import { RunView } from "@/components/runs/run-page";
import type { Debrief, DebriefAnswer } from "@/lib/debrief";
import type { RunRecord } from "@/lib/run-record";
import { doneSource, fixtureShell } from "@/fixtures/data";
import { SeedDebrief } from "@/fixtures/debrief-seed";
import { FixtureLabApi } from "@/fixtures/fixture-api";
import { requireFixtures, type FixtureProps } from "@/fixtures/gate";
import { FIRST_TRY, fixtureRuns } from "@/fixtures/runs";
import { fixtureAudio, fixtureDebrief, heardAnswer, SPOKEN } from "@/fixtures/runs-debrief";

// The debrief of the failed BM3 run (decisions.md, "the run record: the debrief"): ?view=start
// (nothing answered yet; scripts/debrief-timing.mjs starts here), question (question 2, with 1
// answered), transcribing (question 1 just recorded), fix (question 5 with its tap), review
// (question 4 missing, question 2 corrected), waiting (the review while answer 6 is written
// out), run-open (the run page with answers not yet saved) or run-saved (the run page after).
const View = z.enum(["start", "question", "transcribing", "fix", "review", "waiting", "run-open", "run-saved"]).catch("start");

const all = (except: number[] = []): DebriefAnswer[] => ([1, 2, 3, 4, 5, 6] as const).filter((q) => !except.includes(q)).map((q) => heardAnswer(q));
const reviewAnswers = (): DebriefAnswer[] =>
  all([4]).map((a) =>
    a.question === 2
      ? heardAnswer(2, "I expected a strong band at about 118 kDa after induction. The gel showed no band, the same as the uninduced lane.")
      : a.question === 5
        ? { ...a, fixWorked: "yes" }
        : a,
  );
const transcribing = (q: 1 | 6): DebriefAnswer => ({ question: q, words: { kind: "recording", audio: fixtureAudio(q), heard: { kind: "transcribing" }, correction: null }, fixWorked: null });

function seedOf(view: z.infer<typeof View>): { debrief: Debrief | null; startAt?: Screen } {
  switch (view) {
    case "start":
      return { debrief: null };
    case "question":
      return { debrief: fixtureDebrief(FIRST_TRY, all([2, 3, 4, 5, 6])), startAt: { kind: "question", question: 2 } };
    case "transcribing":
      return { debrief: fixtureDebrief(FIRST_TRY, [transcribing(1)]), startAt: { kind: "question", question: 1 } };
    case "fix":
      return { debrief: fixtureDebrief(FIRST_TRY, [...all([5, 6]), { ...heardAnswer(5), fixWorked: "yes" }]), startAt: { kind: "question", question: 5 } };
    case "review":
      return { debrief: fixtureDebrief(FIRST_TRY, reviewAnswers()), startAt: { kind: "review" } };
    case "waiting":
      return { debrief: fixtureDebrief(FIRST_TRY, [...reviewAnswers().filter((a) => a.question !== 6), transcribing(6)]), startAt: { kind: "review" } };
    case "run-open":
      return { debrief: fixtureDebrief(FIRST_TRY, all([4, 5, 6])) };
    case "run-saved":
      return { debrief: fixtureDebrief(FIRST_TRY, reviewAnswers(), "approved") };
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

export default async function DebriefFixture({ searchParams }: FixtureProps) {
  requireFixtures();
  const view = View.parse((await searchParams).view);
  const run = fixtureRuns.find((r) => r.id === FIRST_TRY);
  if (run === undefined) throw new Error("the debrief fixture needs the first try");
  const { debrief, startAt } = seedOf(view);
  const shown: RunRecord =
    view === "run-saved"
      ? {
          ...run,
          debrief: {
            aim: SPOKEN[1],
            expectedSeen: "I expected a strong band at about 118 kDa after induction. The gel showed no band, the same as the uninduced lane.",
            howFound: null,
            whatChanged: SPOKEN[5],
            fixWorked: "yes",
            whoElse: SPOKEN[6],
            debriefedAt: "2026-10-15T17:09:00Z",
          },
        }
      : run;
  return (
    <SeedDebrief debrief={debrief}>
      <FixtureLabApi mode="hybrid" source={doneSource}>
        <AppShell shell={fixtureShell} location={{ section: "runs" }}>
          {view === "run-open" || view === "run-saved" ? <RunView initial={shown} /> : <DebriefFlow run={{ id: run.id, title: run.title }} initial={debrief} startAt={startAt} />}
        </AppShell>
      </FixtureLabApi>
    </SeedDebrief>
  );
}
