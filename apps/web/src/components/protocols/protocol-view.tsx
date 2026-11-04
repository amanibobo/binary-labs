"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { FileHit } from "@/lib/domain";
import { cn } from "@/lib/cn";
import { folderOf, formatDate, openInDropboxUrl } from "@/lib/format";
import { authorName, isCurrent, KIND_NAMES, protocolHref, type AuthorNames, type ProtocolVersion } from "@/lib/protocols";
import { KindIcon } from "../files/kind-icon";
import { PreviewPanel } from "../files/preview-panel";
import { DeleteIcon } from "../icons/base-web";
import { LinkIcon, OpenExternalIcon } from "../icons/drawn";
import { useLabApi } from "../lab-api";
import { Button, buttonVariants } from "../ui/button";
import { dataRow, dataSurface } from "../ui/data-table";
import { Dialog, DialogContent, DialogDock } from "../ui/dialog";
import { CrumbBar } from "./crumb-bar";
import { FilePicker } from "./file-picker";
import { Markdown } from "./markdown";

export function ProtocolView({
  page,
  files,
  authors,
  isAdmin,
}: {
  page: ProtocolVersion;
  files: FileHit[];
  authors: AuthorNames;
  isAdmin: boolean;
}) {
  const current = isCurrent(page);
  const editable = current && !page.archived;
  return (
    <>
      <CrumbBar items={[{ label: page.title, href: protocolHref(page.protocolId) }]} />
      <div className="mx-auto w-full max-w-3xl px-4 pt-8 pb-24 sm:px-8 sm:pt-12">
        {page.archived ? (
          <Notice>This page is archived. It&apos;s hidden from the list and from search, and its versions are kept.</Notice>
        ) : null}
        {current ? null : (
          <Notice>
            You&apos;re reading version {page.version} of {page.currentVersion}.{" "}
            <Link href={protocolHref(page.protocolId)} className="text-content-accent underline underline-offset-2">
              Read the current version
            </Link>
          </Notice>
        )}
        <h1 className="text-heading-medium sm:text-heading-large">{page.title}</h1>
        <p className="mt-2 text-paragraph-small text-content-tertiary">
          {KIND_NAMES[page.kind]} · Version {page.version} · Saved {formatDate(page.createdAt)} by {authorName(authors, page.author)}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {editable ? (
            <Link href={`${protocolHref(page.protocolId)}/edit`} className={buttonVariants({ variant: "secondary", size: "compact" })}>
              Edit
            </Link>
          ) : null}
          <Link
            href={`${protocolHref(page.protocolId)}/history`}
            className={buttonVariants({ variant: editable ? "tertiary" : "secondary", size: "compact" })}
          >
            History
          </Link>
        </div>

        {page.body.trim() === "" ? (
          <p className="mt-10 text-paragraph-medium text-content-tertiary">This page has no text yet.</p>
        ) : (
          <Markdown body={page.body} className="mt-10" />
        )}

        <LinkedFiles page={page} initial={files} editable={editable} />

        {isAdmin && editable ? <ArchiveSection page={page} /> : null}
      </div>
    </>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="mb-6 rounded-control border border-border-opaque bg-background-secondary px-4 py-3 text-paragraph-small text-content-secondary">
      {children}
    </p>
  );
}

function LinkedFiles({ page, initial, editable }: { page: ProtocolVersion; initial: FileHit[]; editable: boolean }) {
  const api = useLabApi();
  const [files, setFiles] = useState(initial);
  const [picking, setPicking] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const headingId = useId();
  const linked = new Set(files.map((f) => f.sha256));

  async function link(hit: FileHit) {
    setFiles((prev) => (prev.some((f) => f.sha256 === hit.sha256) ? prev : [...prev, hit]));
    try {
      await api.linkProtocolFile(page.protocolId, hit.sha256);
    } catch (error) {
      setFiles((prev) => prev.filter((f) => f.sha256 !== hit.sha256));
      toast.error(error instanceof Error ? error.message : "We couldn't link that file.");
    }
  }

  async function unlink(hit: FileHit) {
    const before = files;
    setFiles((prev) => prev.filter((f) => f.sha256 !== hit.sha256));
    try {
      await api.unlinkProtocolFile(page.protocolId, hit.sha256);
      toast(`Unlinked ${hit.label?.cleanName ?? hit.locations[0].originalName}`, {
        action: { label: "Undo", onClick: () => void link(hit) },
      });
    } catch (error) {
      setFiles(before);
      toast.error(error instanceof Error ? error.message : "We couldn't unlink that file.");
    }
  }

  return (
    <section aria-labelledby={headingId} className="mt-14">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 id={headingId} className="text-heading-xsmall">
          Files
        </h2>
        {editable ? (
          <Button variant="secondary" size="compact" onClick={() => setPicking(true)}>
            <LinkIcon className="size-5" />
            Link a file
          </Button>
        ) : null}
      </div>
      {files.length === 0 ? (
        <p className="text-paragraph-medium text-content-tertiary">
          {editable
            ? "No files linked yet. Link a demo video, an example gel or the original document."
            : "No files linked."}
        </p>
      ) : (
        <ul className={dataSurface}>
          {files.map((hit) => (
            <LinkedFileRow
              key={hit.sha256}
              hit={hit}
              expanded={expanded === hit.sha256}
              onToggle={() => setExpanded((cur) => (cur === hit.sha256 ? null : hit.sha256))}
              onUnlink={editable ? () => void unlink(hit) : null}
            />
          ))}
        </ul>
      )}
      <FilePicker open={picking} onOpenChange={setPicking} linked={linked} onLink={(hit) => void link(hit)} />
    </section>
  );
}

// A file row like the search results': the whole row opens the preview, and the end
// actions open the file in Dropbox or take it off the page.
function LinkedFileRow({
  hit,
  expanded,
  onToggle,
  onUnlink,
}: {
  hit: FileHit;
  expanded: boolean;
  onToggle: () => void;
  onUnlink: (() => void) | null;
}) {
  const panelId = useId();
  const [primary] = hit.locations;
  const cleanName = hit.label?.cleanName ?? null;
  const title = cleanName ?? primary.originalName;
  return (
    <li className={cn(dataRow, expanded && "bg-background-secondary")}>
      <div className="relative flex items-stretch">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          className={cn(
            "absolute inset-0 transition-colors duration-150 ease-out focus-visible:outline-offset-[-2px]",
            !expanded && "hover:bg-background-secondary",
          )}
        >
          <span className="sr-only">Details for {title}</span>
        </button>
        <span className="pointer-events-none relative flex shrink-0 pt-4 pl-4 sm:pl-5">
          <KindIcon kind={hit.fileKind} className="mt-0.5" />
        </span>
        <span className="pointer-events-none relative min-w-0 flex-1 py-4 pr-2 pl-4">
          <span className={cn("block truncate text-label-medium text-content-primary", cleanName === null && "font-mono text-label-small")}>
            {title}
          </span>
          {cleanName === null ? null : (
            <span className="mt-0.5 block truncate font-mono text-paragraph-xsmall text-content-secondary">{primary.originalName}</span>
          )}
          <span className={cn("block truncate font-mono text-paragraph-xsmall text-content-tertiary", cleanName === null && "mt-1")}>
            {folderOf(primary)}
          </span>
        </span>
        <span className="relative mt-3 mr-2 flex shrink-0 self-start sm:mt-4">
          {primary.sourceKind === "dropbox" ? (
            <a
              href={openInDropboxUrl(primary.path)}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ variant: "tertiary", shape: "square" }), "text-content-secondary")}
            >
              <OpenExternalIcon />
              <span className="sr-only">Open {primary.originalName} in Dropbox (opens in a new tab)</span>
            </a>
          ) : null}
          {onUnlink === null ? null : (
            <button
              type="button"
              onClick={onUnlink}
              className={cn(buttonVariants({ variant: "tertiary", shape: "square" }), "text-content-secondary")}
            >
              <DeleteIcon />
              <span className="sr-only">Unlink {title}</span>
            </button>
          )}
        </span>
      </div>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <PreviewPanel id={panelId} hit={hit} query="" offerNewPage={false} className="px-4 pt-2 pb-6 sm:pr-5 sm:pl-14" />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

function ArchiveSection({ page }: { page: ProtocolVersion }) {
  const api = useLabApi();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function archive() {
    setBusy(true);
    try {
      await api.archiveProtocol(page.protocolId);
      toast(`Archived ${page.title}`);
      router.push("/protocols");
    } catch (error) {
      setBusy(false);
      toast.error(error instanceof Error ? error.message : "We couldn't archive that page.");
    }
  }

  return (
    <div className="mt-16 border-t border-border-opaque pt-6">
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="tertiary" size="compact" className="-ml-3 text-content-secondary" onClick={() => setOpen(true)}>
          Archive this page
        </Button>
        <DialogContent title="Archive this page?" aria-describedby={undefined}>
          <p className="px-4 pt-3 text-paragraph-medium text-content-secondary sm:px-6">
            It leaves the list and search for everyone in the lab. Every version is kept, so anything that cites one still
            works.
          </p>
          <DialogDock className="pt-6">
            <Button disabled={busy} onClick={() => void archive()}>
              {busy ? "Archiving" : "Archive page"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </DialogDock>
        </DialogContent>
      </Dialog>
    </div>
  );
}
