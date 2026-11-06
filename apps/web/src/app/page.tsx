import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { SearchHome } from "@/components/search/search-home";
import { loadAskHome } from "@/lib/ask-db";
import { loadExperiments, loadPeople, loadRecentFiles, loadSourceState } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export default async function HomePage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab, user } = viewer;
  const [shell, recent, source, experiments, people, ask] = await Promise.all([
    loadShell(viewer),
    loadRecentFiles(supabase, lab.id),
    loadSourceState(supabase, lab.id),
    loadExperiments(supabase, lab.id),
    loadPeople(supabase, lab.id),
    loadAskHome(supabase, lab.id, user.id),
  ]);
  return (
    <AppShell shell={shell} location={{ section: "search" }}>
      <SearchHome
        recent={recent}
        source={source}
        isAdmin={lab.role === "admin"}
        lists={{ experiments, people }}
        ask={ask}
      />
    </AppShell>
  );
}
