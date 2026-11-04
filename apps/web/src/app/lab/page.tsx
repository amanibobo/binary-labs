import type { Metadata } from "next";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { loadExperiments, loadMembers, loadNeedsLookCount, loadPeople, loadSourceState } from "@/lib/lab-data";
import { requireMember } from "@/lib/viewer";
import { LabView } from "./lab-view";

export const metadata: Metadata = { title: "Lab" };

const Notice = z.enum(["denied", "expired", "failed"]).catch("failed");

export default async function LabPage({ searchParams }: PageProps<"/lab">) {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab, user } = viewer;
  const { dropbox } = await searchParams;
  const [source, members, experiments, people, needsLook] = await Promise.all([
    loadSourceState(supabase, lab.id),
    loadMembers(supabase, lab.id),
    loadExperiments(supabase, lab.id),
    loadPeople(supabase, lab.id),
    loadNeedsLookCount(supabase, lab.id),
  ]);
  return (
    <AppShell labName={lab.name} email={user.email} current="lab" needsLookCount={needsLook}>
      <LabView
        labName={lab.name}
        email={user.email}
        isAdmin={lab.role === "admin"}
        source={source}
        members={members}
        experiments={experiments}
        people={people}
        notice={dropbox === undefined ? null : Notice.parse(dropbox)}
      />
    </AppShell>
  );
}
