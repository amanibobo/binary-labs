import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { ProtocolView } from "@/components/protocols/protocol-view";
import { loadProtocolCharts } from "@/lib/chart-store";
import { ProtocolId } from "@/lib/ids";
import { loadAuthorNames, loadLinkedFiles, loadOpenTalkThroughs, loadProtocolVersion, loadProtocolVideos } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { askAvailable, loadOpenSuggestions } from "@/lib/ask-db";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Protocol" };

const VersionParam = z.coerce.number().int().positive().max(2_147_483_647).optional().catch(undefined);

export default async function ProtocolPage({ params, searchParams }: PageProps<"/protocols/[id]">) {
  const id = ProtocolId.safeParse((await params).id);
  if (!id.success) notFound();
  const version = VersionParam.parse((await searchParams).version);
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const [shell, page, files, authors, talkThroughs, videos, charts, waiting] = await Promise.all([
    loadShell(viewer),
    loadProtocolVersion(supabase, id.data, version ?? null),
    loadLinkedFiles(supabase, lab.id, id.data),
    loadAuthorNames(supabase, lab.id),
    loadOpenTalkThroughs(supabase, lab.id, id.data),
    loadProtocolVideos(supabase, id.data),
    loadProtocolCharts(supabase, lab.id, id.data),
    loadOpenSuggestions(supabase, lab.id, id.data).catch(() => []),
  ]);
  if (page === null) notFound();
  return (
    <AppShell shell={shell} location={{ section: "protocols" }}>
      <ProtocolView page={page} files={files} authors={authors} isAdmin={lab.role === "admin"} talkThroughs={talkThroughs} videos={videos} charts={charts} suggestions={{ available: askAvailable(), open: waiting }} />
    </AppShell>
  );
}
