import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { Recorder } from "@/components/talk-throughs/recorder";
import { ProtocolId } from "@/lib/ids";
import { loadProtocolVersion } from "@/lib/lab-data";
import { protocolHref, ProtocolKind } from "@/lib/protocols";
import { loadShell } from "@/lib/shell-data";
import type { TalkThroughTarget } from "@/lib/talk-throughs";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Record a talk-through" };

// ?page=<protocol id> records the next version of that page; ?kind=protocol|tutorial a new page.
export default async function NewTalkThroughPage({ searchParams }: PageProps<"/talk-throughs/new">) {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase } = viewer;
  const params = await searchParams;
  const page = ProtocolId.safeParse(params.page);
  const current = page.success ? await loadProtocolVersion(supabase, page.data, null) : null;
  if (page.success && current === null) notFound();
  if (current?.archived === true) redirect(protocolHref(current.protocolId));
  const target: TalkThroughTarget =
    current === null
      ? { kind: "new", pageKind: ProtocolKind.catch("protocol").parse(params.kind) }
      : { kind: "page", protocolId: current.protocolId, baseVersionId: current.id };
  const shell = await loadShell(viewer);
  return (
    <AppShell shell={shell} location={{ section: "protocols" }}>
      <Recorder target={target} pageTitle={current?.title ?? null} />
    </AppShell>
  );
}
