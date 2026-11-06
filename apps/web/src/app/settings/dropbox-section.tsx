"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { DropboxLogo } from "@/components/icons/drawn";
import { ScanBar, useSourceState } from "@/components/scan-status";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDock } from "@/components/ui/dialog";
import type { SourceState } from "@/lib/source-state";
import { disconnectDropbox, requestRescan } from "./actions";
import { DROPBOX_FOLDER_HREF, type DropboxNotice } from "./sections";
import { ConnectionRow, SettingsGroup, SettingsRow } from "./settings-frame";

const count = new Intl.NumberFormat("en-US");

const NOTICES = {
  denied: "Dropbox access wasn't granted, so nothing was connected.",
  expired: "That Dropbox sign-in took too long or came from another tab. Try connecting again.",
  failed: "We couldn't finish connecting Dropbox. Try again.",
} as const satisfies Record<DropboxNotice, string>;

const icon = <DropboxLogo className="size-5" />;
const path = "font-mono text-paragraph-small text-content-secondary [overflow-wrap:anywhere]";

// A plain link: the OAuth start route answers with a redirect to Dropbox.
const connect = (label: string) => (
  <a href="/api/dropbox/start" className={buttonVariants({ size: "compact" })}>
    {label}
  </a>
);

export function DropboxSection({ initial, isAdmin, notice }: { initial: SourceState; isAdmin: boolean; notice: DropboxNotice | null }) {
  const { data: source } = useSourceState(initial);
  return (
    <div className="grid gap-4">
      {notice === null ? null : (
        <p role="alert" className="text-paragraph-medium text-content-primary">
          {NOTICES[notice]}
        </p>
      )}
      <SettingsGroup>
        <Rows source={source} isAdmin={isAdmin} />
      </SettingsGroup>
    </div>
  );
}

function Rows({ source, isAdmin }: { source: SourceState; isAdmin: boolean }) {
  switch (source.kind) {
    case "not_connected":
      return (
        <ConnectionRow
          icon={icon}
          name="Dropbox"
          status={isAdmin ? "Not connected" : "Not connected. An admin can connect the lab's Dropbox."}
          action={isAdmin ? connect("Connect Dropbox") : null}
        />
      );
    case "needs_folder":
      return (
        <>
          <Connected label={source.accountLabel} isAdmin={isAdmin} />
          <SettingsRow
            label="Folder"
            action={
              isAdmin ? (
                <Link href={DROPBOX_FOLDER_HREF} className={buttonVariants({ size: "compact" })}>
                  Choose folder
                </Link>
              ) : null
            }
          >
            Pick the folder to index.
          </SettingsRow>
        </>
      );
    case "connected":
      return (
        <>
          <Connected label={source.accountLabel} isAdmin={isAdmin} />
          <SettingsRow
            label="Folder"
            action={
              isAdmin ? (
                <Link href={DROPBOX_FOLDER_HREF} className={buttonVariants({ variant: "secondary", size: "compact" })}>
                  Change folder
                </Link>
              ) : null
            }
          >
            <span className={path}>{source.rootPath}</span>
          </SettingsRow>
          <SettingsRow label="Files" action={isAdmin ? <RescanButton /> : null}>
            <div className="mt-2 max-w-sm">
              <ScanBar scan={source.scan} />
            </div>
          </SettingsRow>
        </>
      );
    case "disconnected":
      return (
        <>
          <ConnectionRow
            icon={icon}
            name="Dropbox"
            status={source.accountLabel === null ? "Disconnected" : `Disconnected from ${source.accountLabel}`}
            action={isAdmin ? connect("Connect again") : null}
          />
          {source.rootPath === null ? null : (
            <SettingsRow label="Folder">
              <span className={path}>{source.rootPath}</span>
            </SettingsRow>
          )}
          <SettingsRow label="Files">
            {source.indexed === 0
              ? "Nothing new is read until Dropbox is connected again."
              : `The ${count.format(source.indexed)} ${source.indexed === 1 ? "file" : "files"} already indexed stay searchable. Nothing new is read until Dropbox is connected again.`}
            {isAdmin ? null : " An admin can connect it again."}
          </SettingsRow>
        </>
      );
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function Connected({ label, isAdmin }: { label: string | null; isAdmin: boolean }) {
  return (
    <ConnectionRow
      icon={icon}
      name="Dropbox"
      status={label === null ? "Connected" : `Connected as ${label}`}
      action={isAdmin ? <DisconnectButton /> : null}
    />
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
      <Button variant="secondary" size="compact" onClick={() => setOpen(true)}>
        Disconnect
      </Button>
      <DialogContent title="Disconnect Dropbox?" aria-describedby={undefined}>
        <div className="grid gap-3 px-4 pt-3 text-paragraph-medium text-content-secondary sm:px-6">
          <p>
            Binary stops reading the folder and gives up its access to your Dropbox. Nothing in Dropbox changes.
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
