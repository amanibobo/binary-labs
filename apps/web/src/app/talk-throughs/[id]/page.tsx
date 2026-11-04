import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { TalkThroughView } from "@/components/talk-throughs/talk-through-view";
import { TalkThroughId } from "@/lib/ids";
import { loadAuthorNames, loadTalkThrough } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Talk-through" };

export default async function TalkThroughPage({ params }: PageProps<"/talk-throughs/[id]">) {
  const id = TalkThroughId.safeParse((await params).id);
  if (!id.success) notFound();
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, talkThrough, authors] = await Promise.all([
    loadShell(viewer),
    loadTalkThrough(supabase, id.data),
    loadAuthorNames(supabase, lab.id),
  ]);
  if (talkThrough === null) notFound();
  return (
    <AppShell shell={shell} location={{ section: "protocols" }}>
      <TalkThroughView initial={talkThrough} authors={authors} />
    </AppShell>
  );
}
