import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { TaskView } from "@/components/runs/export/task-page";
import { PersonId, RunId } from "@/lib/ids";
import { loadPeople } from "@/lib/lab-data";
import { loadRun } from "@/lib/run-record-store";
import { loadShell } from "@/lib/shell-data";
import { unwrap } from "@/lib/supabase/server";
import { loadRunTask } from "@/lib/task-folder-store";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "Make a task" };

// One run on its way to becoming a task folder: the second scientist's question and rubric,
// the record with names taken out, and the folder.
export default async function TaskPage({ params }: PageProps<"/runs/[id]/export">) {
  const id = RunId.safeParse((await params).id);
  if (!id.success) notFound();
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const { supabase, lab, user } = viewer;
  const [shell, run, task, people, mine] = await Promise.all([
    loadShell(viewer),
    loadRun(supabase, id.data),
    loadRunTask(supabase, id.data),
    loadPeople(supabase, lab.id),
    supabase.from("people").select("id").eq("lab_id", lab.id).eq("member_user_id", user.id).limit(1),
  ]);
  // Another lab's run reads as no run at all.
  if (run === null || task === null) notFound();
  const me = z.array(z.object({ id: PersonId })).parse(unwrap(mine))[0]?.id ?? null;
  return (
    <AppShell shell={shell} location={{ section: "runs" }}>
      <TaskView run={run} initial={task} people={people.map((p) => ({ id: p.id, name: p.name }))} me={me} />
    </AppShell>
  );
}
