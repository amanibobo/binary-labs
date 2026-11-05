import { z } from "zod";
import { FRESH_STATE, NO_PROGRESS, QUIET_STATE, type OnboardingData, type OnboardingState, type Progress } from "@/lib/onboarding";

// ?onboarding= on the Search and Upload fixtures. Every other fixture keeps onboarding quiet,
// so the older screenshots don't change.
export const OnboardingFixture = z.enum(["quiet", "new", "checklist", "member", "hints"]).catch("quiet");
export type OnboardingFixture = z.infer<typeof OnboardingFixture>;

const day = (d: number) => `2026-11-0${d}T15:00:00Z`;
// Joined, connected Dropbox and searched; still to invite, add a protocol and upload.
const started: Progress = { ...NO_PROGRESS, joinedAt: day(1), dropboxAt: day(1), searchedAt: day(2) };
const seen: OnboardingState = { ...FRESH_STATE, welcomeSeen: true, tourStep: 5, tourEnded: { how: "done", at: day(2) } };

const FIXTURES: Record<OnboardingFixture, Omit<OnboardingData, "tourHref">> = {
  quiet: { role: "admin", state: QUIET_STATE, progress: started },
  new: { role: "admin", state: FRESH_STATE, progress: { ...NO_PROGRESS, joinedAt: day(1), dropboxAt: day(1) } },
  checklist: { role: "admin", state: seen, progress: started },
  member: { role: "member", state: { ...FRESH_STATE, welcomeSeen: true }, progress: { ...NO_PROGRESS, joinedAt: day(2), searchedAt: day(2) } },
  hints: { role: "admin", state: { ...seen, checklistHidden: true }, progress: started },
};

export function fixtureOnboarding(kind: OnboardingFixture): OnboardingData {
  return { ...FIXTURES[kind], tourHref: `/dev/fixtures/search?onboarding=${kind}&tour=1` };
}
