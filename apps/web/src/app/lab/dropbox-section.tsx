"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ScanBar, useSourceState } from "@/components/scan-status";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDock } from "@/components/ui/dialog";
import type { SourceState } from "@/lib/source-state";
import { cn } from "@/lib/cn";
import { disconnectDropbox, requestRescan } from "./actions";

const count = new Intl.NumberFormat("en-US");

export function DropboxSection({ initial, isAdmin }: { initial: SourceState; isAdmin: boolean }) {
  const { data: source } = useSourceState(initial);
  switch (source.kind) {
    case "not_connected":
      return isAdmin ? (
        <div>
          <p className="max-w-prose text-paragraph-medium text-content-primary">
            Binary Labs asks Dropbox for read-only access, indexes one folder you pick, and never moves, renames or changes
            a file.
          </p>
          {/* A plain link: the OAuth start route answers with a redirect to Dropbox. */}
          <a href="/api/dropbox/start" className={cn(buttonVariants(), "mt-4")}>
            Connect Dropbox
          </a>
        </div>
      ) : (
        <p className="text-paragraph-medium text-content-primary">Not connected yet. An admin can connect the lab&apos;s Dropbox.</p>
      );
    case "needs_folder":
      return (
        <div>
          <Account label={source.accountLabel} />
          <p className="mt-3 text-paragraph-medium text-content-primary">Pick the folder to index.</p>
          {isAdmin ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/lab/folder" className={buttonVariants()}>
                Choose folder
              </Link>
              <DisconnectButton />
            </div>
          ) : null}
        </div>
      );
    case "connected":
      return (
        <div>
          <Account label={source.accountLabel} />
          <dl className="mt-3">
            <dt className="text-paragraph-small text-content-tertiary">Folder</dt>
            <dd className="font-mono text-paragraph-small [overflow-wrap:anywhere] text-content-primary">{source.rootPath}</dd>
          </dl>
          <div className="mt-5">
            <ScanBar scan={source.scan} />
          </div>
          {isAdmin ? (
            <div className="mt-5 flex flex-wrap gap-2">
              <RescanButton />
              <Link href="/lab/folder" className={buttonVariants({ variant: "secondary" })}>
                Change folder
              </Link>
              <DisconnectButton />
            </div>
          ) : null}
        </div>
      );
    case "disconnected":
      return (
        <div>
          <p className="text-paragraph-medium text-content-primary">
            Disconnected{source.accountLabel === null ? "" : " from "}
            {source.accountLabel === null ? null : <span className="font-medium">{source.accountLabel}</span>}
          </p>
          {source.rootPath === null ? null : (
            <dl className="mt-3">
              <dt className="text-paragraph-small text-content-tertiary">Folder</dt>
              <dd className="font-mono text-paragraph-small [overflow-wrap:anywhere] text-content-primary">{source.rootPath}</dd>
            </dl>
          )}
          <p className="mt-3 max-w-prose text-paragraph-medium text-content-secondary">
            {source.indexed === 0
              ? "Nothing new is read until Dropbox is connected again."
              : `The ${count.format(source.indexed)} ${source.indexed === 1 ? "file" : "files"} already indexed stay searchable. Nothing new is read until Dropbox is connected again.`}
          </p>
          {isAdmin ? (
            <a href="/api/dropbox/start" className={cn(buttonVariants(), "mt-4")}>
              Connect again
            </a>
          ) : (
            <p className="mt-3 text-paragraph-medium text-content-secondary">An admin can connect it again.</p>
          )}
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
    <p className="text-paragraph-medium text-content-primary">
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

function DisconnectButton() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  const router = useRouter();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="tertiary" onClick={() => setOpen(true)}>
        Disconnect
      </Button>
      <DialogContent title="Disconnect Dropbox?" aria-describedby={undefined}>
        <div className="grid gap-3 px-4 pt-3 text-paragraph-medium text-content-secondary sm:px-6">
          <p>
            Binary Labs stops reading the folder and gives up its access to your Dropbox. Nothing in Dropbox changes.
          </p>
          <p>
            Files already indexed stay searchable, with their previews and labels. New and changed files aren&apos;t picked
            up until you connect again.
          </p>
        </div>
        <DialogDock className="pt-6">
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await disconnectDropbox();
                if (result.kind === "error") {
                  toast.error(result.message);
                  return;
                }
                setOpen(false);
                toast("Dropbox disconnected");
                await queryClient.invalidateQueries({ queryKey: ["source-state"] });
                router.refresh();
              })
            }
          >
            {pending ? "Disconnecting" : "Disconnect Dropbox"}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogDock>
      </DialogContent>
    </Dialog>
  );
}
