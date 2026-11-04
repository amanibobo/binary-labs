import type { Metadata } from "next";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { loadMembers, loadSourceState } from "@/lib/lab-data";
import { requireMember } from "@/lib/viewer";
import { LabView } from "./lab-view";

export const metadata: Metadata = { title: "Lab" };

const Notice = z.enum(["denied", "expired", "failed"]).catch("failed");

export default async function LabPage({ searchParams }: PageProps<"/lab">) {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab, user } = viewer;
  const { dropbox } = await searchParams;
  const [source, members] = await Promise.all([loadSourceState(supabase, lab.id), loadMembers(supabase, lab.id)]);
  return (
    <AppShell labName={lab.name} email={user.email} current="lab">
      <LabView
        labName={lab.name}
        email={user.email}
        isAdmin={lab.role === "admin"}
        source={source}
        members={members}
        notice={dropbox === undefined ? null : Notice.parse(dropbox)}
      />
    </AppShell>
  );
}
