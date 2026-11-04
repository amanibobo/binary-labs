import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ConfigMissing } from "@/components/config-missing";
import { LabId } from "@/lib/ids";
import { LAB_DELETION_COLUMNS, LabDeletionRow } from "@/lib/lab-deletion";
import { unwrap } from "@/lib/supabase/server";
import { loadViewer } from "@/lib/viewer";
import { DeletedView } from "./deleted-view";

export const metadata: Metadata = { title: "Lab deleted" };

// Only the person who asked can read a lab_deletions row, so this works after the lab is gone.
export default async function DeletedPage({ searchParams }: PageProps<"/deleted">) {
  const viewer = await loadViewer();
  switch (viewer.kind) {
    case "config_missing":
      return <ConfigMissing missing={viewer.missing} />;
    case "signed_out":
      return redirect("/sign-in");
    case "no_lab":
    case "member":
      break;
    default: {
      const _exhaustive: never = viewer;
      return _exhaustive;
    }
  }
  const labId = LabId.safeParse((await searchParams).lab);
  if (!labId.success) notFound();
  const rows = z
    .array(LabDeletionRow)
    .parse(unwrap(await viewer.supabase.from("lab_deletions").select(LAB_DELETION_COLUMNS).eq("lab_id", labId.data)));
  const deletion = rows[0];
  if (deletion === undefined) notFound();
  return <DeletedView deletion={deletion} />;
}
