import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { ProtocolEditor } from "@/components/protocols/protocol-editor";
import { TalkThroughId } from "@/lib/ids";
import { loadAuthorNames, loadProtocolVersion, loadTalkThrough } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { editorStart, talkThroughHref } from "@/lib/talk-throughs";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Use a talk-through" };

// The editor, filled with a talk-through's drafted steps (or ?from=transcript, its transcript).
export default async function UseTalkThroughPage({ params, searchParams }: PageProps<"/talk-throughs/[id]/edit">) {
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
  const start = editorStart(talkThrough, (await searchParams).from === "transcript" ? "transcript" : "steps");
  if (start === null) redirect(talkThroughHref(talkThrough.id));
  const base = talkThrough.page === null ? null : await loadProtocolVersion(supabase, talkThrough.page.protocolId, talkThrough.page.baseVersion);
  if (talkThrough.page !== null && (base === null || base.archived)) redirect(talkThroughHref(talkThrough.id));
  return (
    <AppShell shell={shell} location={{ section: "protocols" }}>
      <ProtocolEditor
        key={talkThrough.id}
        mode={{ kind: "talk_through", talkThroughId: talkThrough.id, base, pageKind: talkThrough.kind, ...start }}
        authors={authors}
      />
    </AppShell>
  );
}
