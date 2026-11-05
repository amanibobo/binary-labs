"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { ScanBar, useSourceState } from "@/components/scan-status";
import { Button, buttonVariants } from "@/components/ui/button";
import { dataRow, dataSurface } from "@/components/ui/data-table";
import { Dialog, DialogContent, DialogDock } from "@/components/ui/dialog";
import { progressLine, type SourceState } from "@/lib/source-state";
import { cn } from "@/lib/cn";
import { disconnectDropbox, requestRescan } from "./actions";

const count = new Intl.NumberFormat("en-US");

export function DropboxStatus({ initial }: { initial: SourceState }) {
  const { data: source } = useSourceState(initial);
  switch (source.kind) {
    case "not_connected":
      return "Not connected";
    case "needs_folder":
      return "Pick a folder to index";
    case "connected":
      return progressLine(source.scan);
    case "disconnected":
      return "Disconnected";
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

export function DropboxSection({ initial, isAdmin }: { initial: SourceState; isAdmin: boolean }) {
  const { data: source } = useSourceState(initial);
  switch (source.kind) {
    case "not_connected":
      return (
        <div className={cn(dataSurface, "p-5 sm:p-6")}>
          {isAdmin ? (
            <>
              <p className="max-w-prose text-paragraph-medium text-content-primary">
                Binary Labs asks Dropbox for read-only access, indexes one folder you pick, and never moves, renames or
                changes a file.
              </p>
              {/* A plain link: the OAuth start route answers with a redirect to Dropbox. */}
              <a href="/api/dropbox/start" className={cn(buttonVariants(), "mt-4")}>
                Connect Dropbox
              </a>
            </>
          ) : (
            <p className="text-paragraph-medium text-content-primary">Not connected yet. An admin can connect the lab&apos;s Dropbox.</p>
          )}
        </div>
      );
    case "needs_folder":
      return (
        <dl className={dataSurface}>
          <AccountRow label={source.accountLabel} isAdmin={isAdmin} />
          <Row
            label="Folder"
            action={
              isAdmin ? (
                <Link href="/lab/folder" className={buttonVariants({ size: "compact" })}>
                  Choose folder
                </Link>
              ) : null
            }
          >
            <span className="text-content-tertiary">Pick the folder to index.</span>
          </Row>
        </dl>
      );
    case "connected":
      return (
        <dl className={dataSurface}>
          <AccountRow label={source.accountLabel} isAdmin={isAdmin} />
          <Row
            label="Folder"
            action={
              isAdmin ? (
                <Link href="/lab/folder" className={buttonVariants({ variant: "secondary", size: "compact" })}>
                  Change folder
                </Link>
              ) : null
            }
          >
            <span className="font-mono text-paragraph-small [overflow-wrap:anywhere]">{source.rootPath}</span>
          </Row>
          <Row label="Files" action={isAdmin ? <RescanButton /> : null}>
            <ScanBar scan={source.scan} />
          </Row>
        </dl>
      );
    case "disconnected":
      return (
        <div className={dataSurface}>
          <div className="p-5 sm:px-6">
            <p className="text-label-medium text-content-primary">Disconnected</p>
            <p className="mt-1 max-w-prose text-paragraph-medium text-content-secondary">
              {source.indexed === 0
                ? "Nothing new is read until Dropbox is connected again."
                : `The ${count.format(source.indexed)} ${source.indexed === 1 ? "file" : "files"} already indexed stay searchable. Nothing new is read until Dropbox is connected again.`}
            </p>
          </div>
          <dl className="border-t border-border-opaque">
            {source.accountLabel === null ? null : (
              <Row label="Account">
                <span className="[overflow-wrap:anywhere]">{source.accountLabel}</span>
              </Row>
            )}
            {source.rootPath === null ? null : (
              <Row label="Folder">
                <span className="font-mono text-paragraph-small [overflow-wrap:anywhere]">{source.rootPath}</span>
              </Row>
            )}
          </dl>
          <div className="border-t border-border-opaque p-5 sm:px-6">
            {isAdmin ? (
              <a href="/api/dropbox/start" className={buttonVariants()}>
                Connect again
              </a>
            ) : (
              <p className="text-paragraph-medium text-content-secondary">An admin can connect it again.</p>
            )}
          </div>
        </div>
      );
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function Row({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className={cn(dataRow, "grid min-h-14 items-center gap-1 px-5 py-3 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-4 sm:px-6")}>
      <dt className="text-paragraph-small text-content-tertiary">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-paragraph-medium text-content-primary">
        <div className="min-w-0 flex-1 basis-32">{children}</div>
        {action}
      </dd>
    </div>
  );
}

function AccountRow({ label, isAdmin }: { label: string | null; isAdmin: boolean }) {
  return (
    <Row label="Account" action={isAdmin ? <DisconnectButton /> : null}>
      <span className="[overflow-wrap:anywhere]">{label ?? "Connected"}</span>
    </Row>
  );
}

function RescanButton() {
  const [pending, startTransition] = useTransition();
  const queryClient = useQueryClient();
  return (
    <Button
      variant="secondary"
      size="compact"
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
      <Button variant="tertiary" size="compact" onClick={() => setOpen(true)}>
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
