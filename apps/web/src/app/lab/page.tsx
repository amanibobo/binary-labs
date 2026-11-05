import type { Metadata } from "next";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { loadExperiments, loadMembers, loadPeople, loadSourceState } from "@/lib/lab-data";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";
import { SettingsArea } from "./areas";
import { LabView } from "./lab-view";

export const metadata: Metadata = { title: "Settings" };

const Notice = z.enum(["denied", "expired", "failed"]).catch("failed");
const Area = SettingsArea.nullable().catch(null);

export default async function LabPage({ searchParams }: PageProps<"/lab">) {
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab, user } = viewer;
  const { dropbox, area } = await searchParams;
  const notice = dropbox === undefined ? null : Notice.parse(dropbox);
  const [shell, source, members, experiments, people] = await Promise.all([
    loadShell(viewer),
    loadSourceState(supabase, lab.id),
    loadMembers(supabase, lab.id),
    loadExperiments(supabase, lab.id),
    loadPeople(supabase, lab.id),
  ]);
  return (
    <AppShell shell={shell} location={{ section: "lab" }}>
      <LabView
        area={notice === null ? Area.parse(area ?? null) : "dropbox"}
        labName={lab.name}
        email={user.email}
        isAdmin={lab.role === "admin"}
        source={source}
        members={members}
        experiments={experiments}
        people={people}
        notice={notice}
      />
    </AppShell>
  );
}
