"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";
import { ScanBar, useSourceState } from "@/components/scan-status";
import { Button, buttonVariants } from "@/components/ui/button";
import type { SourceState } from "@/lib/source-state";
import { cn } from "@/lib/cn";
import { requestRescan } from "./actions";

export function DropboxSection({ initial, isAdmin }: { initial: SourceState; isAdmin: boolean }) {
  const { data: source } = useSourceState(initial);
  switch (source.kind) {
    case "not_connected":
      return isAdmin ? (
        <div>
          <p className="max-w-prose text-[15px] text-ink">
            Binary Labs asks Dropbox for read-only access, indexes one folder you pick, and never moves, renames or changes
            a file.
          </p>
          {/* A plain link: the OAuth start route answers with a redirect to Dropbox. */}
          <a href="/api/dropbox/start" className={cn(buttonVariants(), "mt-4")}>
            Connect Dropbox
          </a>
        </div>
      ) : (
        <p className="text-[15px] text-ink">Not connected yet. An admin can connect the lab&apos;s Dropbox.</p>
      );
    case "needs_folder":
      return (
        <div>
          <Account label={source.accountLabel} />
          <p className="mt-3 text-[15px] text-ink">Pick the folder to index.</p>
          {isAdmin ? (
            <Link href="/lab/folder" className={cn(buttonVariants(), "mt-4")}>
              Choose folder
            </Link>
          ) : null}
        </div>
      );
    case "connected":
      return (
        <div>
          <Account label={source.accountLabel} />
          <dl className="mt-3">
            <dt className="text-[13px] text-muted">Folder</dt>
            <dd className="font-mono text-[13.5px] [overflow-wrap:anywhere] text-ink">{source.rootPath}</dd>
          </dl>
          <div className="mt-5">
            <ScanBar scan={source.scan} />
          </div>
          {isAdmin ? (
            <div className="mt-5 flex flex-wrap gap-2">
              <RescanButton />
              <Link href="/lab/folder" className={buttonVariants({ variant: "quiet" })}>
                Change folder
              </Link>
            </div>
          ) : null}
        </div>
      );
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function Account({ label }: { label: string | null }) {
  return (
    <p className="text-[15px] text-ink">
      Connected{label === null ? "" : " as "}
      {label === null ? null : <span className="font-medium">{label}</span>}
    </p>
  );
}

function RescanButton() {
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await requestRescan();
          if (result.kind === "error") toast.error(result.message);
          else toast.success("Rescan requested. New and changed files show up as they're read.");
          await queryClient.invalidateQueries({ queryKey: ["source-state"] });
        })
      }
    >
      {pending ? "Requesting rescan" : "Rescan"}
    </Button>
  );
}
