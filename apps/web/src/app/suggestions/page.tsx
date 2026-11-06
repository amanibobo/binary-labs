import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { SuggestionList } from "@/components/ask/suggestion-list";
import { ConfigMissing } from "@/components/config-missing";
import { loadOpenSuggestions } from "@/lib/ask-db";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Suggestions" };

export default async function SuggestionsPage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, items] = await Promise.all([loadShell(viewer), loadOpenSuggestions(supabase, lab.id, null)]);
  return (
    <AppShell shell={shell} location={{ section: "search" }}>
      <SuggestionList items={items} />
    </AppShell>
  );
}
