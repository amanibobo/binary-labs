import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SuggestionView } from "@/components/ask/suggestion-view";
import { ConfigMissing } from "@/components/config-missing";
import { loadSuggestion } from "@/lib/ask-db";
import { SuggestionId } from "@/lib/ids";
import { loadAuthorNames } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Suggestion" };

export default async function SuggestionPage({ params }: PageProps<"/suggestions/[id]">) {
  const id = SuggestionId.safeParse((await params).id);
  if (!id.success) notFound();
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab, user } = viewer;
  const [shell, suggestion, authors] = await Promise.all([loadShell(viewer), loadSuggestion(supabase, lab.id, id.data), loadAuthorNames(supabase, lab.id)]);
  if (suggestion === null) notFound();
  return (
    <AppShell shell={shell} location={{ section: suggestion.kind === "protocol_edit" ? "protocols" : "search" }}>
      <SuggestionView suggestion={suggestion} authors={authors} viewerId={user.id} />
    </AppShell>
  );
}
