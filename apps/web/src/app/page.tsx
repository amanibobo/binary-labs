import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { SearchHome } from "@/components/search/search-home";
import { loadExperiments, loadPeople, loadRecentFiles, loadSourceState } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export default async function HomePage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, recent, source, experiments, people] = await Promise.all([
    loadShell(viewer),
    loadRecentFiles(supabase, lab.id),
    loadSourceState(supabase, lab.id),
    loadExperiments(supabase, lab.id),
    loadPeople(supabase, lab.id),
  ]);
  return (
    <AppShell shell={shell} location={{ section: "search" }}>
      <SearchHome
        recent={recent}
        source={source}
        isAdmin={lab.role === "admin"}
        lists={{ experiments, people }}
      />
    </AppShell>
  );
}
