import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { QuestionsView } from "@/components/ask/questions-view";
import { ConfigMissing } from "@/components/config-missing";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Questions" };

export default async function QuestionsPage() {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const shell = await loadShell(viewer);
  return (
    <AppShell shell={shell} location={{ section: "search" }}>
      <QuestionsView viewerId={viewer.user.id} />
    </AppShell>
  );
}
