import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { ProtocolEditor } from "@/components/protocols/protocol-editor";
import { Sha256 } from "@/lib/ids";
import { loadAuthorNames, loadStartFile } from "@/lib/lab-data";
import { titleFromFile } from "@/lib/protocols";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "New protocol" };

export default async function NewProtocolPage({ searchParams }: PageProps<"/protocols/new">) {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab } = viewer;
  // ?from=<sha256> starts the page from that file; an unknown file just starts a blank page.
  const from = Sha256.safeParse((await searchParams).from);
  const [shell, authors, start] = await Promise.all([
    loadShell(viewer),
    loadAuthorNames(supabase, lab.id),
    from.success ? loadStartFile(supabase, lab.id, from.data) : Promise.resolve(null),
  ]);
  const title =
    start === null ? "" : titleFromFile({ cleanName: start.hit.label?.cleanName ?? null, originalName: start.hit.locations[0].originalName });
  return (
    <AppShell shell={shell} location={{ section: "protocols" }}>
      <ProtocolEditor mode={{ kind: "create", from: start, title }} authors={authors} />
    </AppShell>
  );
}
