"use client";

import { toast } from "sonner";
import { cn } from "@/lib/cn";
import type { NoteInfo, NotePage } from "@/lib/domain";
import { pageCaption, withoutPage } from "@/lib/notes";
import { useLabels, type LabeledFile } from "../labels/labels-context";
import { useLabApi } from "../lab-api";

// Runs a change to a note, shows it on the row at once, and says so; Undo when there is one.
function useNoteChange(hit: LabeledFile) {
  const labels = useLabels();
  return async function change({
    run,
    after,
    message,
    undo,
  }: {
    run: () => Promise<void>;
    after: NoteInfo | null;
    message: string;
    undo?: { run: () => Promise<void>; after: NoteInfo | null; message: string };
  }) {
    try {
      await run();
      labels.setNote(hit, after);
      toast(
        message,
        undo === undefined
          ? undefined
          : { action: { label: "Undo", onClick: () => void change({ run: undo.run, after: undo.after, message: undo.message }) } },
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We couldn't change that note. Try again.");
    }
  };
  // `api` is read inside the callers' run functions.
}

// A note's pages: the one being read, large, with where it is ("Page 7 of 12 · Readings"), and
// every page as a numbered square to step to.
export function NotePreview({
  hit,
  note,
  page,
  onPage,
}: {
  hit: LabeledFile;
  note: NoteInfo;
  page: NotePage;
  onPage: (page: NotePage) => void;
}) {
  const api = useLabApi();
  const change = useNoteChange(hit);
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
      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-paragraph-xsmall text-content-tertiary">
        <span aria-live="polite">{pageCaption(note, page)}</span>
        <span aria-hidden>·</span>
        <button
          type="button"
          onClick={() =>
            void change({
              run: () => api.changeNote({ action: "remove_page", noteId: note.id, sha256: page.sha256 }),
              after: withoutPage(note, page.sha256),
              message: `Page ${page.position} is its own file again`,
            })
          }
          className="-mx-1 rounded-md px-1 text-content-secondary hover:bg-background-tertiary hover:text-content-primary max-sm:min-h-11"
        >
          Take this page out
        </button>
      </p>
      <ol aria-label="Pages" className="mt-2 flex flex-wrap gap-1">
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
                  "flex size-7 items-center justify-center rounded-md text-label-xsmall tabular-nums transition-colors duration-150 ease-out max-sm:size-11",
                  on
                    ? "bg-button-primary-fill text-content-inverse-primary"
                    : "text-content-secondary ring-1 ring-border-opaque ring-inset hover:bg-background-tertiary hover:text-content-primary",
                )}
              >
                {p.position}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// The note in one line beside Open: how many pages and why they're together, then Keep (while
// Binary only suggested it) and Split. Splitting can be undone from the toast.
export function NoteControls({ hit, note }: { hit: LabeledFile; note: NoteInfo }) {
  const api = useLabApi();
  const change = useNoteChange(hit);
  const kept: NoteInfo = { ...note, state: "confirmed" };
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-paragraph-small text-content-secondary">
      <span>
        One note of {note.pages.length} pages{note.state === "suggested" ? ` (${note.reason.toLowerCase()})` : ""}.
      </span>
      {note.state === "suggested" ? (
        <button
          type="button"
          onClick={() => void change({ run: () => api.changeNote({ action: "keep", noteId: note.id }), after: kept, message: "Kept as one note" })}
          className={noteAction}
        >
          Keep
        </button>
      ) : null}
      {note.state === "suggested" ? <span aria-hidden>·</span> : null}
      <button
        type="button"
        onClick={() =>
          void change({
            run: () => api.changeNote({ action: "split", noteId: note.id }),
            after: null,
            message: `Split into ${note.pages.length} files`,
            undo: { run: () => api.changeNote({ action: "restore", noteId: note.id }), after: kept, message: "Back to one note" },
          })
        }
        className={noteAction}
      >
        Split into pages
      </button>
    </p>
  );
}

const noteAction =
  "-mx-1 inline-flex min-h-7 items-center rounded-md px-1 text-label-small text-content-primary transition-colors duration-150 ease-out hover:bg-background-tertiary max-sm:min-h-11";
