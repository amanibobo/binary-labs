import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { SearchHome } from "@/components/search/search-home";
import { loadRecentFiles, loadSourceState } from "@/lib/lab-data";
import { requireMember } from "@/lib/viewer";

export default async function HomePage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [recent, source] = await Promise.all([loadRecentFiles(supabase, lab.id), loadSourceState(supabase, lab.id)]);
  return (
    <AppShell labName={lab.name} current="search">
      <SearchHome recent={recent} source={source} isAdmin={lab.role === "admin"} />
    </AppShell>
  );
}
