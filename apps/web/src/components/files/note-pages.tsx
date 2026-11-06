"use client";

import { toast } from "sonner";
import { cn } from "@/lib/cn";
import type { FileHit, NoteInfo, NotePage } from "@/lib/domain";
import { pageCaption, withoutPage } from "@/lib/notes";
import { useLabels } from "../labels/labels-context";
import { useLabApi } from "../lab-api";

// A note's pages: the one being read, large, and every page as a numbered square to step to.
export function NotePreview({
  note,
  page,
  onPage,
}: {
  note: NoteInfo;
  page: NotePage;
  onPage: (page: NotePage) => void;
}) {
  const api = useLabApi();
  const name = page.location?.originalName ?? `page ${page.position}`;
  return (
    <div className="min-w-0">
      <div className="flex min-h-32 items-center justify-center overflow-hidden rounded-xl border border-border-opaque bg-background-primary">
        {page.hasPreview ? (
          // eslint-disable-next-line @next/next/no-img-element -- previews are short-lived presigned redirects
          <img src={api.previewUrl(page.sha256, { view: true })} alt={`Page ${page.position}: ${name}`} className="max-h-72 w-full object-contain" />
        ) : (
          <p className="p-4 text-paragraph-small text-content-tertiary">No preview for this page yet.</p>
        )}
      </div>
      <p className="mt-1.5 text-paragraph-xsmall text-content-tertiary" aria-live="polite">
        {pageCaption(note, page)}
      </p>
      <ol aria-label="Pages" className="mt-2 flex flex-wrap gap-1.5">
        {note.pages.map((p) => {
          const on = p.sha256 === page.sha256;
          return (
            <li key={p.sha256}>
              <button
                type="button"
                aria-current={on ? "page" : undefined}
                aria-label={`Page ${p.position}`}
                onClick={() => onPage(p)}
                className={cn(
                  "relative size-9 overflow-hidden rounded-md border text-label-xsmall transition-colors duration-150 ease-out max-sm:size-11",
                  on ? "border-content-primary ring-1 ring-content-primary" : "border-border-opaque hover:border-content-tertiary",
                )}
              >
                {p.hasPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- previews are short-lived presigned redirects
                  <img src={api.previewUrl(p.sha256, { view: false })} alt="" className="absolute inset-0 size-full object-cover object-top opacity-70" />
                ) : null}
                <span className="relative rounded-sm bg-background-primary/80 px-1 text-content-primary">{p.position}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// The note's own controls, said once: why Binary grouped the pages (until someone keeps them)
// and the way back to separate files. Splitting can be undone from the toast.
export function NoteControls({ hit, note, page }: { hit: FileHit; note: NoteInfo; page: NotePage }) {
  const api = useLabApi();
  const labels = useLabels();

  async function run(action: () => Promise<void>, after: () => void, message: string, undo?: () => Promise<void>) {
    try {
      await action();
      after();
      toast(message, undo === undefined ? undefined : { action: { label: "Undo", onClick: () => void undo() } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't change that note. Try again.");
    }
  }

  const split = () =>
    run(
      () => api.changeNote({ action: "split", noteId: note.id }),
      () => labels.setNote(hit, null),
      `Split into ${note.pages.length} files`,
      () =>
        run(
          () => api.changeNote({ action: "restore", noteId: note.id }),
          () => labels.setNote(hit, { ...note, state: "confirmed" }),
          "Back to one note",
        ),
    );
  const keep = () =>
    run(
      () => api.changeNote({ action: "keep", noteId: note.id }),
      () => labels.setNote(hit, { ...note, state: "confirmed" }),
      "Kept as one note",
    );
  const takeOut = () =>
    run(
      () => api.changeNote({ action: "remove_page", noteId: note.id, sha256: page.sha256 }),
      () => labels.setNote(hit, withoutPage(note, page.sha256)),
      `Page ${page.position} taken out`,
    );

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-paragraph-small text-content-secondary">
      {note.state === "suggested" ? (
        <>
          <span className="mr-1">
            Binary grouped these {note.pages.length} pages: {note.reason.toLowerCase()}.
          </span>
          <button type="button" onClick={() => void keep()} className={noteAction}>
            Keep as one note
          </button>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <button type="button" onClick={() => void split()} className={noteAction}>
        Split into separate files
      </button>
      <span aria-hidden>·</span>
      <button type="button" onClick={() => void takeOut()} className={noteAction}>
        Take page {page.position} out
      </button>
    </div>
  );
}

const noteAction =
  "-mx-1 inline-flex min-h-7 items-center rounded-md px-1 text-label-small text-content-primary transition-colors duration-150 ease-out hover:bg-background-tertiary max-sm:min-h-11";
