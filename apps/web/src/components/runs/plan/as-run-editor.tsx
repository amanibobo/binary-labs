"use client";

import { useId, useState } from "react";
import { readLines, writeLines, type ProtocolLine } from "@/lib/as-run";
import { cn } from "@/lib/cn";
import { plainText } from "@/lib/protocols";
import { Button } from "../../ui/button";

const quietAction =
  "inline-flex min-h-7 items-center rounded-md px-1.5 text-label-small text-content-secondary transition-colors duration-150 ease-out hover:bg-background-tertiary hover:text-content-primary max-sm:min-h-11";

type Line = ProtocolLine & { id: number };

// What was actually done, one line of the protocol at a time: change a step's words, take out
// a step that was skipped, add one that wasn't written down. Headings and tables are shown
// and kept as they are. Nothing is saved until Save.
export function AsRunEditor({ start, saving, onSave, onCancel }: { start: string; saving: boolean; onSave: (body: string) => void; onCancel: () => void }) {
  const [lines, setLines] = useState<Line[]>(() =>
    (start.trim() === "" ? [{ kind: "text" as const, lead: "", text: "", number: null }] : readLines(start)).map((line, id) => ({ ...line, id })),
  );
  const [focus, setFocus] = useState<number | null>(null);

  const change = (id: number, text: string) => setLines((all) => all.map((l) => (l.id === id ? { ...l, text } : l)));
  const takeOut = (id: number) => setLines((all) => all.filter((l) => l.id !== id));
  const addAfter = (line: Line) => {
    const added: Line = { kind: line.kind, lead: line.lead, text: "", number: null, id: Math.max(...lines.map((l) => l.id)) + 1 };
    setLines((all) => all.flatMap((l) => (l.id === line.id ? [l, added] : [l])));
    setFocus(added.id);
  };
  // Steps are numbered in the order they stand now.
  const stepOf = new Map<number, number>();
  for (const line of lines) if (line.kind === "step") stepOf.set(line.id, stepOf.size + 1);

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(writeLines(lines));
      }}
    >
      <p className="max-w-prose text-paragraph-small text-content-secondary">
        Change any step to what you actually did. Take out steps you skipped, and add any you did that aren&apos;t written here.
      </p>
      <ol aria-label="What was done" className="grid gap-1.5">
        {lines.map((line) => {
          if (line.kind === "blank") return null;
          if (line.kind === "heading") {
            return (
              <li key={line.id} className="mt-3 text-label-medium text-content-primary first:mt-0">
                {plainText(line.text)}
              </li>
            );
          }
          if (line.kind === "fixed") {
            const words = plainText(line.text);
            return words === "" ? null : (
              <li key={line.id} className="text-paragraph-small text-content-tertiary">
                {words}
              </li>
            );
          }
          const step = stepOf.get(line.id);
          return (
            <EditableLine
              key={line.id}
              label={step === undefined ? null : `Step ${step}`}
              text={line.text}
              autoFocus={focus === line.id}
              onChange={(text) => change(line.id, text)}
              onAddAfter={() => addAfter(line)}
              onTakeOut={() => takeOut(line.id)}
              addLabel={line.kind === "step" ? "Add a step after" : "Add a line after"}
            />
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="compact" disabled={saving}>
          {saving ? "Saving…" : "Save what was done"}
        </Button>
        <Button type="button" variant="tertiary" size="compact" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EditableLine(props: {
  label: string | null;
  text: string;
  autoFocus: boolean;
  addLabel: string;
  onChange: (text: string) => void;
  onAddAfter: () => void;
  onTakeOut: () => void;
}) {
  const id = useId();
  const name = props.label ?? "This line";
  return (
    <li className="grid gap-1 sm:grid-cols-[4.5rem_1fr] sm:gap-x-3">
      <label htmlFor={id} className={cn("pt-1.5 text-label-small text-content-tertiary", props.label === null && "sr-only")}>
        {name}
      </label>
      <div className="min-w-0 sm:col-start-2">
        <textarea
          id={id}
          rows={1}
          autoFocus={props.autoFocus}
          value={props.text}
          onChange={(e) => props.onChange(e.target.value.replace(/\n/g, " "))}
          className="field-sizing-content block min-h-8 w-full resize-none rounded-md border border-border-opaque bg-background-primary px-2 py-1.5 text-paragraph-small text-content-primary max-sm:min-h-11 max-sm:text-paragraph-medium"
        />
        <div className="mt-0.5 flex flex-wrap gap-x-1">
          <button type="button" onClick={props.onAddAfter} className={quietAction}>
            {props.addLabel}
          </button>
          <button type="button" onClick={props.onTakeOut} className={quietAction}>
            Take out<span className="sr-only"> {name.toLowerCase()}</span>
          </button>
        </div>
      </div>
    </li>
  );
}
