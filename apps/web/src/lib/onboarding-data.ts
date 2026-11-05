import "server-only";
import { logError } from "./log";
import { NO_PROGRESS, OnboardingRows, ProgressRows, QUIET_STATE, type OnboardingData } from "./onboarding";
import { unwrap } from "./supabase/server";
import type { Member } from "./viewer";

const STATE_COLUMNS = "welcome_seen_at, tour_step, tour_ended, tour_ended_at, checklist_hidden_at, hints_seen";

// Every page's shell loads this, so a failure here never fails the page: it logs and shows
// nothing, rather than greeting someone again on every visit.
export async function loadOnboarding({ supabase, lab, user }: Member): Promise<OnboardingData> {
  const base = { role: lab.role, tourHref: "/?tour=1" };
  try {
    const [state, progress] = await Promise.all([
      supabase.from("onboarding").select(STATE_COLUMNS).eq("user_id", user.id),
      supabase.rpc("onboarding_progress", { p_lab_id: lab.id }),
    ]);
    return { ...base, state: OnboardingRows.parse(unwrap(state)), progress: ProgressRows.parse(unwrap(progress)) };
  } catch (error) {
    logError("onboarding.load_failed", { labId: lab.id, error });
    return { ...base, state: QUIET_STATE, progress: NO_PROGRESS };
  }
}
