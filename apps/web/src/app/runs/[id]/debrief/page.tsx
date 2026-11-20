import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ConfigMissing } from "@/components/config-missing";
import { DebriefFlow } from "@/components/runs/debrief/debrief-flow";
import { buttonVariants } from "@/components/ui/button";
import { loadRunDebrief } from "@/lib/debrief-store";
import { RunId } from "@/lib/ids";
import { loadRun } from "@/lib/run-record-store";
import { loadShell } from "@/lib/shell-data";
import { requireMember } from "@/lib/viewer";

export const metadata: Metadata = { title: "What happened" };

// The six questions about a run that failed or was odd, one per screen, then the review.
export default async function RunDebriefPage({ params }: PageProps<"/runs/[id]/debrief">) {
  const id = RunId.safeParse((await params).id);
  if (!id.success) notFound();
  const viewer = await requireMember();
  if (viewer.kind === "config_missing") return <ConfigMissing missing={viewer.missing} />;
  const [shell, run, debrief] = await Promise.all([loadShell(viewer), loadRun(viewer.supabase, id.data), loadRunDebrief(viewer.supabase, id.data)]);
  if (run === null) notFound();
  const wentWrong = run.status === "failed" || run.status === "odd";
  return (
    <AppShell shell={shell} location={{ section: "runs" }}>
      {wentWrong ? (
        <DebriefFlow run={{ id: run.id, title: run.title }} initial={debrief} />
      ) : (
        <div className="mx-auto w-full max-w-2xl px-4 pt-10 pb-24 sm:px-8">
          <h1 className="text-heading-medium">Mark how the run went first</h1>
          <p className="mt-2 max-w-prose text-paragraph-medium text-content-secondary">These questions are for a run that failed or was odd.</p>
          <Link href={`/runs/${run.id}`} className={`${buttonVariants({ variant: "secondary" })} mt-6`}>
            Back to the run
          </Link>
        </div>
      )}
    </AppShell>
  );
}
