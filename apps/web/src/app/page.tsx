import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { SearchHome } from "@/components/search/search-home";
import { loadExperiments, loadNeedsLookCount, loadPeople, loadRecentFiles, loadSourceState } from "@/lib/lab-data";
import { requireMember } from "@/lib/viewer";

export default async function HomePage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab, user } = viewer;
  const [recent, source, needsLook, experiments, people] = await Promise.all([
    loadRecentFiles(supabase, lab.id),
    loadSourceState(supabase, lab.id),
    loadNeedsLookCount(supabase, lab.id),
    loadExperiments(supabase, lab.id),
    loadPeople(supabase, lab.id),
  ]);
  return (
    <AppShell labName={lab.name} email={user.email} current="search" needsLookCount={needsLook}>
      <SearchHome
        labName={lab.name}
        recent={recent}
        source={source}
        isAdmin={lab.role === "admin"}
        lists={{ experiments, people }}
      />
    </AppShell>
  );
}
