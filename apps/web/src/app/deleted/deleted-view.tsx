import Link from "next/link";
import { signOut } from "@/app/actions";
import { CenteredCard } from "@/components/centered-card";
import { Button, buttonVariants } from "@/components/ui/button";
import type { LabDeletion, RemovedCounts } from "@/lib/lab-deletion";
import { RefreshWhilePending } from "./refresh-while-pending";

const count = new Intl.NumberFormat("en-US");

const REMOVED_ROWS = [
  ["files", "Files in the index"],
  ["previews", "Stored files and previews"],
  ["labels", "Labels"],
  ["protocols", "Protocols and tutorials"],
  ["members", "Members"],
] as const satisfies readonly (readonly [keyof RemovedCounts, string])[];

export function DeletedView({ deletion }: { deletion: LabDeletion }) {
  return (
    <CenteredCard
      title={deletion.kind === "pending" ? "Your lab is being deleted" : "Your lab was deleted"}
      description={
        deletion.kind === "pending"
          ? "Every member lost access when you confirmed. The rest is removed within a few minutes, and you can close this page."
          : "Binary holds nothing from it any more. We keep only a record that the deletion happened, and when."
      }
    >
      {deletion.kind === "pending" ? (
        <>
          <RefreshWhilePending />
          <dl className="grid gap-3 text-paragraph-medium">
            <Row term="Removed" detail="Member access and the Dropbox connection" />
            <Row term="Removing" detail="The index, labels, protocols, uploads, recordings, videos and activity log" />
            <Row term="Not touched" detail="Files in Dropbox" />
          </dl>
        </>
      ) : (
        <>
          <h2 className="mb-2 text-label-medium text-content-primary">Removed</h2>
          <dl className="grid gap-2 text-paragraph-medium">
            {REMOVED_ROWS.map(([key, term]) => (
              <div key={key} className="flex items-baseline justify-between gap-4">
                <dt className="text-content-secondary">{term}</dt>
                <dd className="tabular-nums">{count.format(deletion.removed[key])}</dd>
              </div>
            ))}
            <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-border-opaque pt-3">
              <dt className="text-content-secondary">Files in Dropbox</dt>
              <dd>Untouched</dd>
            </div>
          </dl>
        </>
      )}
      <div className="mt-8 flex flex-wrap gap-2">
        <Link href="/new-lab" className={buttonVariants({ variant: "secondary" })}>
          Create a lab
        </Link>
        <form action={signOut}>
          <Button type="submit" variant="tertiary">
            Sign out
          </Button>
        </form>
      </div>
    </CenteredCard>
  );
}

function Row({ term, detail }: { term: string; detail: string }) {
  return (
    <div>
      <dt className="text-label-medium text-content-primary">{term}</dt>
      <dd className="text-content-secondary">{detail}</dd>
    </div>
  );
}
