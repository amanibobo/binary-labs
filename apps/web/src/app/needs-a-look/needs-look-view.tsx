"use client";

import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { KindIcon } from "@/components/files/kind-icon";
import { useLabApi } from "@/components/lab-api";
import { LabelsProvider, useLabels } from "@/components/labels/labels-context";
import { dataRow, dataSurface } from "@/components/ui/data-table";
import { Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import type { LabeledFileHit } from "@/lib/domain";
import { folderOf } from "@/lib/format";

export function NeedsLookView({ files }: { files: LabeledFileHit[] }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 pt-8 pb-24 sm:px-8 sm:pt-16">
      <h1 className="text-heading-large">Needs a look</h1>
      <p className="mt-1 max-w-prose text-paragraph-medium text-content-tertiary">
        Files we couldn&apos;t read or weren&apos;t sure about. Say what each one is in a few words, and similar files will
        follow your lead.
      </p>
      <LabelsProvider>
        <Queue files={files} />
      </LabelsProvider>
    </div>
  );
}

function Queue({ files }: { files: LabeledFileHit[] }) {
  const { labelOf } = useLabels();
  // A named file leaves the list; undo puts it back where it was.
  const waiting = files.filter((file) => labelOf(file)?.status === "needs_look");
  return (
    <>
      <p className="sr-only" aria-live="polite">
        {waiting.length === 1 ? "1 file left" : `${waiting.length} files left`}
      </p>
      {waiting.length === 0 ? (
        <p className="mt-8 text-paragraph-medium text-content-secondary">Nothing needs a look right now.</p>
      ) : null}
      <ul className={cn(dataSurface, "mt-8", waiting.length === 0 && "hidden")}>
        <AnimatePresence initial={false}>
          {waiting.map((file) => (
            <motion.li
              key={file.sha256}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className={cn(dataRow, "overflow-hidden")}
            >
              <QueueRow file={file} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </>
  );
}

function QueueRow({ file }: { file: LabeledFileHit }) {
  const api = useLabApi();
  const labels = useLabels();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const [primary] = file.locations;

  return (
    <div className="flex items-start gap-4 py-4 pr-4 pl-4 sm:pr-5 sm:pl-5">
      <KindIcon kind={file.fileKind} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-label-medium text-content-primary">{primary.originalName}</p>
            <p className="mt-1 truncate font-mono text-paragraph-xsmall text-content-tertiary">{folderOf(primary)}</p>
            {file.snippet !== null && file.fileKind !== "image" ? (
              <p className="mt-2 line-clamp-2 text-paragraph-small text-content-secondary">{file.snippet}</p>
            ) : null}
          </div>
          {file.hasPreview ? (
            // eslint-disable-next-line @next/next/no-img-element -- previews are short-lived presigned redirects
            <img
              src={api.previewUrl(file.sha256, { view: false })}
              alt={`Preview of ${primary.originalName}`}
              loading="lazy"
              className="size-14 shrink-0 rounded-lg border border-border-opaque bg-background-secondary object-cover sm:size-16"
            />
          ) : null}
        </div>
        <label htmlFor={`${id}-what`} className="sr-only">
          What is {primary.originalName}?
        </label>
        <Input
          id={`${id}-what`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            const outcome = labels.edit(file, { kind: "rename", text }, `Saved as “${text.trim()}”`);
            if (outcome.kind === "invalid") setError(outcome.message);
          }}
          placeholder="What is this?"
          enterKeyHint="done"
          autoComplete="off"
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : `${id}-error`}
          className="mt-3"
        />
        {error === null ? null : (
          <p id={`${id}-error`} role="alert" className="mt-1.5 text-paragraph-small text-content-primary">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
