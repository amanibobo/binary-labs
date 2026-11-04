import type { Metadata } from "next";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { ProtocolListView } from "@/components/protocols/protocol-list-view";
import { loadAuthorNames, loadProtocols } from "@/lib/lab-data";
import { ProtocolKind } from "@/lib/protocols";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Protocols" };

const Filter = z.union([ProtocolKind, z.literal("all")]).catch("all");

export default async function ProtocolsPage({ searchParams }: PageProps<"/protocols">) {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  const { kind } = await searchParams;
  const [shell, protocols, authors] = await Promise.all([
    loadShell(viewer),
    loadProtocols(supabase, lab.id),
    loadAuthorNames(supabase, lab.id),
  ]);
  return (
    <AppShell shell={shell} location={{ section: "protocols" }}>
      <ProtocolListView protocols={protocols} authors={authors} initialFilter={Filter.parse(kind)} />
    </AppShell>
  );
}
